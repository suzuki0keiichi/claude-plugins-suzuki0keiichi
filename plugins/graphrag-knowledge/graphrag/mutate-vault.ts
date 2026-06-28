import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  rmdirSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { buildVaultFiles } from "./build-vault.ts";
import { importVault, normalizeEol } from "./import-vault.ts";
import {
  normalizeMutationPlan,
  validateMutation,
} from "./mutation-core.ts";
import { buildAndWriteVectorIndex } from "./build-vector-index.ts";
import { defaultVectorIndexPath, loadVectorIndex } from "./retrieval.ts";
import { stateDirForVault } from "./cli-env.ts";
import { withVaultLock, beginVaultWrite, endVaultWrite } from "./vault-lock.ts";
import { runDuplicateCheck } from "./duplicate-check.ts";
import { embedQueryForVectorIndex } from "./vector.ts";
import { suggestBindingsForNodes } from "./suggest-policy-edges.ts";
import { readRecentHitIds } from "./cli-ask-state.ts";
import { canonicalType, DEFAULT_SCHEMA, type SchemaDefinition } from "./schema.ts";

function writeFileAtomic(abs: string, content: string): void {
  mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, abs);
  } catch (e) {
    // rename 失敗(Windows EPERM・ハンドル競合等)時に tmp を座礁させない。
    // 旧実装は tmp が新内容を保持したまま残り、手動昇格でしか復旧できなかった。
    // 失敗は呼び出し元(applyMutationToVault)へ伝播し、そちらが HEAD へ巻き戻す。
    try {
      unlinkSync(tmp);
    } catch {
      /* noop */
    }
    throw e;
  }
}

function listMdFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const abs = path.join(d, e);
      if (statSync(abs).isDirectory()) {
        // ドットで始まるディレクトリ(.obsidian/.git/.graphrag 等)は孤児削除の対象外。
        // Obsidian がテンプレ/デイリーノートを .md で置くことがあるため walk しない。
        if (e.startsWith(".")) continue;
        walk(abs);
      } else if (e.endsWith(".md")) out.push(abs);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

// 孤児 .md 削除で空になった型フォルダを掃除する。例: 全 Pocket ノードが Component へ
// 改名されると Pocket/*.md は消えるが、空の Pocket/ ディレクトリだけが残骸として
// 残る (旧型のフォルダが空のまま居座る)。dot ディレクトリ (.git/.obsidian/.graphrag 等)
// と vault ルート自体は対象外。rmdirSync は空でないと失敗するので非空フォルダは安全に残る。
function pruneEmptyDirs(root: string): string[] {
  const pruned: string[] = [];
  const prune = (d: string): void => {
    for (const e of readdirSync(d)) {
      if (e.startsWith(".")) continue;
      const abs = path.join(d, e);
      if (statSync(abs).isDirectory()) prune(abs);
    }
    if (d !== root && readdirSync(d).length === 0) {
      rmdirSync(d);
      pruned.push(path.relative(root, d));
    }
  };
  if (existsSync(root)) prune(root);
  return pruned;
}

/**
 * nextGraph を vault に反映。変更ファイルのみ原子書き、生成集合に無い .md は孤児として削除。
 * created は「この呼び出しで新規作成した(以前は存在しなかった)」ファイル(written の部分集合)。
 * commit 失敗時の rollback で untracked な新規ファイルを削除するために返す。
 */
export function writeVaultDelta(
  vaultDir: string,
  nextGraph: any,
  sink?: { written: string[]; removed: string[]; created: string[] }
): { written: string[]; removed: string[]; created: string[] } {
  const files = buildVaultFiles(nextGraph);
  const wantAbs = new Set(files.map((f) => path.join(vaultDir, f.relPath)));
  // sink を渡すと途中まで書いた written/created がそこに積まれる。多ファイル適用が
  // 途中で throw しても呼び出し元が partial を把握でき、HEAD への巻き戻しで untracked
  // な新規ファイル(created)を確実に消せる。
  const written: string[] = sink?.written ?? [];
  const created: string[] = sink?.created ?? [];
  for (const f of files) {
    const abs = path.join(vaultDir, f.relPath);
    const existed = existsSync(abs);
    const cur = existed ? readFileSync(abs, "utf8") : undefined;
    // EOL 差 (Windows autocrlf による CRLF) だけのファイルは書き直さない。
    // 生成物 (f.content) は常に LF なので、両者を LF 正規化して内容比較する。
    // これをしないと CRLF チェックアウトの vault で 1 mutation 毎に全ファイルが
    // churn (LF へ全書き直し) してしまう。
    if (cur === undefined || normalizeEol(cur) !== normalizeEol(f.content)) {
      writeFileAtomic(abs, f.content);
      written.push(f.relPath);
      if (!existed) created.push(f.relPath);
    }
  }
  const removed: string[] = sink?.removed ?? [];
  for (const abs of listMdFiles(vaultDir)) {
    if (!wantAbs.has(abs)) {
      unlinkSync(abs);
      removed.push(path.relative(vaultDir, abs));
    }
  }
  // 型フォルダのリネーム/削除で空になったディレクトリを掃除 (旧型の空フォルダ残骸防止)。
  if (removed.length > 0) pruneEmptyDirs(vaultDir);
  return { written, removed, created };
}

/**
 * commit 失敗時に vault working tree を HEAD まで巻き戻す(mutation を完全に取り消す)。
 * tracked な変更/削除は git restore で元に戻し、この mutation が新規作成した untracked
 * ファイル(created)は restore の対象外なので個別に削除する。best effort。
 */
function rollbackVaultWorktree(vaultDir: string, created: string[]): void {
  // undo tracked modifications/deletions and unstage, back to HEAD
  try {
    execFileSync("git", ["restore", "--source=HEAD", "--staged", "--worktree", "--", "."], {
      cwd: vaultDir,
    });
  } catch {
    /* best effort */
  }
  // remove files this mutation newly created (untracked, unaffected by restore)
  for (const rel of created) {
    try {
      unlinkSync(path.join(vaultDir, rel));
    } catch {
      /* noop */
    }
  }
}

export function vaultHead(vaultDir: string): string {
  return execFileSync("git", ["-C", vaultDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

/**
 * vault git が branch に乗っている(detached HEAD でない)ことを保証する。
 * vault を submodule 化すると `git submodule update` が detached HEAD で
 * チェックアウトする。その状態で commit するとどのブランチにも乗らず浮き、
 * 後で GC されうる。commit を原子境界にする以上、確定先 branch が無い状態での
 * mutation は明示的に止める(submodule 利用者には branch checkout を促す)。
 * 初回コミット前の unborn branch は symbolic-ref が通る(detached ではない)ので素通り。
 */
function assertOnBranch(vaultDir: string): void {
  try {
    execFileSync("git", ["-C", vaultDir, "symbolic-ref", "-q", "HEAD"], {
      encoding: "utf8",
    });
  } catch {
    const err: any = new Error(
      `vault git is in detached HEAD (no branch to commit onto). ` +
        `Checkout a branch first (submodule users: \`git -C ${vaultDir} checkout main\`).`
    );
    err.code = "DETACHED_HEAD";
    throw err;
  }
}

function gitCommitVault(vaultDir: string, message: string): string {
  // git add は vaultDir を cwd にして "." で stage する。git の toplevel を
  // path.relative で求める方式は、macOS の /var → /private/var シンボリックリンク
  // 解決で root と vaultDir の prefix がずれ、"outside repository" になるため使わない。
  execFileSync("git", ["add", "--", "."], { cwd: vaultDir });
  const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd: vaultDir,
    encoding: "utf8",
  }).trim();
  if (staged) execFileSync("git", ["commit", "-q", "-m", message], { cwd: vaultDir });
  return vaultHead(vaultDir);
}

// ── E0/E3/E4/E5/E6 書き込み時提案 ────────────────────────────────────────
// apply 成功後に、新規作成された知識ノードに対する suggest-only な手がかりを組む。
// すべて非致命: index/endpoint 不在は各提案を空 + reason で skip し、書き込みは決して
// 止めない (apply は既に commit 済み)。エッジは一切張らない (提案のみ)。

// binding_debt の定義は check-carving gate #9 (knowledge-impl-binding-missing) +
// #9 拡張 (constraint-binding-missing) と一致させる。check-carving に依存させず自前で
// 数えるが、判定式はそちらと同一 (相互参照: check-carving.ts の isImplFileBinding /
// constraint-binding-missing)。
function isImplFileBinding(toId: string): boolean {
  return toId.startsWith("file:") && !/docs\/knowhow\/|plans\/|docs\/design-decisions\//.test(toId);
}
function countBindingDebt(graph: { nodes?: any[]; edges?: any[] }): number {
  const outEdges = new Map<string, any[]>();
  for (const e of graph.edges ?? []) {
    const arr = outEdges.get(e.from) ?? [];
    arr.push(e);
    outEdges.set(e.from, arr);
  }
  let debt = 0;
  for (const n of graph.nodes ?? []) {
    const t = canonicalType(n.type);
    const oe = outEdges.get(n.id) ?? [];
    if (t === "Decision" || t === "OperationalKnowledge" || t === "Risk") {
      // #9: 実装ファイルへの sets_policy_for / documented_by が無ければ debt。
      const hasPolicy = oe.some((e) => e.type === "sets_policy_for" && isImplFileBinding(e.to));
      const hasImplDoc = oe.some((e) => e.type === "documented_by" && isImplFileBinding(e.to));
      if (!hasPolicy && !hasImplDoc) debt += 1;
    } else if (t === "Constraint") {
      // #9 拡張: constrains エッジ (宛先不問) が 0 本なら debt。
      if (!oe.some((e) => e.type === "constrains")) debt += 1;
    }
  }
  return debt;
}

// schema.categories.premiseCandidate から構築 (buildSuggestions 内で参照)。

/**
 * apply 成功後の suggestions オブジェクトを組む。全フィールド suggest-only・非致命。
 * - binding: 新規 Decision/OK/Risk/Constraint ごとに File embedding 近接候補 (型別固定エッジ型)。
 * - relations: 重複ゲートが副産物計算した [0.80,0.92) 帯ペア。
 * - led_to: Decision 新規作成があり graph に state:"active" Investigation が居れば列挙。
 * - premise_candidates: ask-trail 直近ヒットのうち Decision/Constraint/Goal/OK 型 (自分自身除外)。
 * - binding_debt: gate #9 + Constraint 拡張と同じ定義の整数。
 */
async function buildSuggestions(args: {
  nextGraph: { nodes?: any[]; edges?: any[] };
  plan: any;
  relations: any[];
  vectorIndex: { rows?: any[] } | null | undefined;
  embed: ((text: string) => Promise<number[]>) | null;
  recentHitIds: string[];
  schema?: SchemaDefinition;
}): Promise<any> {
  const createdIds = new Set(
    (args.plan.nodes ?? [])
      .filter((n: any) => (n.op ?? "create") === "create")
      .map((n: any) => n.id)
  );
  const nodeById = new Map<string, any>((args.nextGraph.nodes ?? []).map((n: any) => [n.id, n]));
  const createdNodes = [...createdIds].map((id) => nodeById.get(id)).filter(Boolean);

  // binding: 新規の Decision/OK/Risk/Constraint だけを対象に File 近接候補。
  let binding: any;
  if (!args.vectorIndex || !Array.isArray(args.vectorIndex.rows) || args.vectorIndex.rows.length === 0) {
    binding = { suggestions: [], skipped: "vector index unavailable" };
  } else if (!args.embed) {
    binding = { suggestions: [], skipped: "embedding endpoint unavailable" };
  } else {
    try {
      const list = await suggestBindingsForNodes({
        vectorIndex: args.vectorIndex,
        nodes: createdNodes,
        embed: args.embed,
      });
      binding = { suggestions: list };
    } catch (e: any) {
      binding = { suggestions: [], skipped: `embedding unavailable: ${String(e?.message ?? e)}` };
    }
  }

  // led_to: Decision 新規作成があるときだけ。state:"active" の Investigation を列挙。
  const createdHasDecision = createdNodes.some((n) => canonicalType(n.type) === "Decision");
  const led_to = createdHasDecision
    ? (args.nextGraph.nodes ?? [])
        .filter((n: any) => canonicalType(n.type) === "Investigation" && n.state === "active")
        .map((n: any) => ({ investigation_id: n.id, title: n.title }))
    : [];

  // premise_candidates: ask-trail 直近ヒットのうち Decision/Constraint/Goal/OK 型。自分自身除外。
  const premise_candidates = args.recentHitIds
    .filter((id) => !createdIds.has(id))
    .map((id) => nodeById.get(id))
    .filter((n) => n && new Set((args.schema ?? DEFAULT_SCHEMA).categories.premiseCandidate).has(canonicalType(n.type, args.schema) ?? ""))
    .map((n) => ({ node_id: n.id, node_type: canonicalType(n.type), title: n.title }));

  return {
    binding,
    relations: args.relations,
    led_to,
    premise_candidates,
    binding_debt: countBindingDebt(args.nextGraph),
  };
}

/**
 * vault への mutation 適用一式を lock 内で実行する。
 * 流れ: lock → OCC(base_sha vs HEAD) → import → normalize/validate → 重複ゲート(非致命 skip 可) →
 * seq begin → on-branch 保証 → writeVaultDelta → 索引再構築(非致命) → git commit → seq end。
 * 索引(vector.json)は再生成可能な二次成果物なので、ビルド失敗しても
 * mutation は中断せず commit まで進め index_status で結果を返す。
 * 原子性: git commit(ref 前進)を唯一の確定境界とし、適用中のどの失敗(writeVaultDelta
 * 途中失敗・commit 失敗)でも作業ツリーを HEAD へ巻き戻す。外から見える正本状態は常に
 * 「古い HEAD」か「新しい HEAD」だけになり、base_sha↔HEAD の OCC が実際に効く。
 */
export async function applyMutationToVault(args: {
  plan: any;
  vaultDir: string;
  stateDir?: string;
  baseSha?: string;
  reason?: string;
  git?: boolean;
  schema?: SchemaDefinition;
  buildIndex?: (a: { vault: string; out: string }) => Promise<unknown> | unknown;
  vectorDeps?: any;
  // 書き込み時重複ゲートの DI (buildIndex と同様、テストで FS/endpoint 非依存にする)。
  dupDeps?: {
    loadIndex?: () => Promise<any> | any;
    embed?: (text: string) => Promise<number[]>;
    threshold?: number;
  };
  // E0 書き込み時提案の DI (binding 用 index/embed と ask-trail base dir)。
  // 全て省略可: 既定は再構築後の vector index を読み、embed は index ポリシー準拠の
  // query 埋め込み、recentHitIds は stateDir から読む。失敗・不在は全て非致命 skip。
  suggestDeps?: {
    loadIndex?: () => Promise<any> | any;
    embed?: (text: string) => Promise<number[]>;
    recentHitIds?: () => string[];
  };
  // テスト用 DI (buildIndex と同様)。途中失敗時の巻き戻しを検証するため、
  // 一部書いてから throw する writer を差し込めるようにしている。
  writeDelta?: (
    vaultDir: string,
    nextGraph: any,
    sink: { written: string[]; removed: string[]; created: string[] }
  ) => { written: string[]; removed: string[]; created: string[] };
}): Promise<any> {
  const vaultDir = path.resolve(args.vaultDir);
  // 既定レイアウト <root>/.graphrag/vault でも <root>/.graphrag/.graphrag を
  // 掘らないよう、冪等な stateDirForVault に集約 (retrieval.loadGraph と同一規約)。
  const stateDir = args.stateDir ?? stateDirForVault(vaultDir);
  // 既定の索引ビルドは buildAndWriteVectorIndex (out へ実際に書き出す版)。
  // buildVectorIndex は payload を返すだけなので直に使うと索引が更新されない。
  // vectorDeps は provider 等の DI 用 (テストで endpoint 非依存にする等)。
  const buildIndex =
    args.buildIndex ??
    ((a: { vault: string; out: string }) =>
      buildAndWriteVectorIndex({ vault: a.vault, out: a.out }, args.vectorDeps ?? {}));
  mkdirSync(stateDir, { recursive: true });
  const result = await withVaultLock(stateDir, async () => {
    // OCC: base_sha が現 HEAD と違えば「古い判断」として拒否（粗い粒度）。
    if (args.baseSha) {
      const head = vaultHead(vaultDir);
      if (head !== args.baseSha) {
        const err: any = new Error(
          `OCC conflict: base_sha ${args.baseSha} != HEAD ${head} (stale judgment; re-read and rebuild plan)`
        );
        err.code = "OCC_STALE";
        throw err;
      }
    }
    const current = importVault(vaultDir);
    const plan = normalizeMutationPlan(args.plan);
    const v = validateMutation({ currentGraph: current, plan, enforceSourceBacking: true, schema: args.schema });
    if (!v.valid) {
      const err: any = new Error("Refusing to mutate invalid graph");
      err.failures = v.failures;
      throw err;
    }

    // 書き込み時重複ゲート: op:create の知識/横断ノードを既存索引と embedding 照合し、
    // duplicate_ack で承認されない suspect が居れば all-or-nothing で拒否する。
    // 索引不在・embedding 不達は非致命スキップ (index_status と同じ扱い)。
    const dupDeps = args.dupDeps ?? {};
    let dupIndex: any = null;
    try {
      dupIndex = await (dupDeps.loadIndex
        ? dupDeps.loadIndex()
        : loadVectorIndex(defaultVectorIndexPath(vaultDir)));
    } catch {
      dupIndex = null; // 索引が読めない = 不在扱いで skip (NON-FATAL)
    }
    const dup = await runDuplicateCheck({
      plan,
      currentGraph: current,
      vectorIndex: dupIndex,
      embed: dupDeps.embed ?? ((text: string) => embedQueryForVectorIndex(text, dupIndex)),
      threshold: dupDeps.threshold,
    });
    if (dup.failures.length > 0) {
      const err: any = new Error(
        "Refusing to create duplicate-suspect nodes (pass duplicate_ack with the existing node ids to override)"
      );
      err.code = "DUPLICATE_SUSPECT";
      err.failures = dup.failures;
      err.duplicate_check = { suspects: dup.suspects };
      throw err;
    }
    const duplicate_check = {
      status: dup.status,
      ...(dup.reason ? { reason: dup.reason } : {}),
      suspects: dup.suspects,
    };
    // relations は副産物 (suggest-only)。lock 外の suggestions 組み立てに渡すため保持。
    const relationCandidates = dup.relations ?? [];

    const began = beginVaultWrite(stateDir);
    // 適用中に書いた partial をここに積む。writeVaultDelta が途中で throw しても
    // created が残るので、巻き戻しで untracked な新規ファイルを確実に消せる。
    const delta = { written: [] as string[], removed: [] as string[], created: [] as string[] };
    const writeDelta = args.writeDelta ?? writeVaultDelta;
    try {
      // commit を確定境界にするので、確定先 branch が無い(detached HEAD)なら適用前に止める。
      if (args.git !== false) assertOnBranch(vaultDir);
      writeDelta(vaultDir, v.nextGraph, delta);
      let head: string | null = null;
      if (args.git !== false) {
        head = gitCommitVault(vaultDir, args.reason ?? plan.reason ?? "graphrag mutation");
      }
      return {
        applied: true,
        head,
        duplicate_check,
        files: delta,
        changed_nodes: {
          created: plan.nodes
            .filter((n: any) => (n.op ?? "create") === "create")
            .map((n: any) => n.id),
          updated: plan.nodes.filter((n: any) => n.op === "update").map((n: any) => n.id),
          deleted: plan.nodes.filter((n: any) => n.op === "delete").map((n: any) => n.id),
        },
        cascaded_edge_ids: v.cascadedEdgeIds,
        // lock 外の suggestions 組み立てに渡す内部フィールド (出力直前に除去する)。
        __suggestionsInput: { nextGraph: v.nextGraph, plan, relations: relationCandidates },
      };
    } catch (applyErr) {
      // 適用中のどの失敗(writeVaultDelta 途中失敗・commit 失敗等)でも作業ツリーを
      // HEAD へ巻き戻し、部分適用を残さない。git 無効モードは巻き戻す HEAD が無いので
      // best-effort で created の untracked ファイルだけ消す。
      if (args.git !== false) rollbackVaultWorktree(vaultDir, delta.created);
      else
        for (const rel of delta.created) {
          try {
            unlinkSync(path.join(vaultDir, rel));
          } catch {
            /* noop */
          }
        }
      throw applyErr;
    } finally {
      endVaultWrite(stateDir, began);
    }
  });

  // 索引(vector.json)は再生成可能な二次成果物で、書き込みは自前で原子的・後勝ち
  // (build-vector-index の writeFileAtomic コメント参照。ロックを張らない並行モデル)。
  // よって索引再構築は vault ロックの外・seq 書込窓の外で行う。これにより:
  //  (1) embedding のネットワーク IO がクリティカルセクションに入らない (endpoint が
  //      ハングしてもグラフ全体が固まらない・読みは seqlock で止まらない)。
  //  (2) ロック保持時間が writeVaultDelta + git commit だけになり、seqlock の前提
  //      「書込窓は極短」が回復する。
  // 索引は増分ビルド (変更ノードだけ再 embedding) なので解放後でも軽い。失敗しても
  // mutation は既に確定済みなので非致命 (index_status で結果だけ返す)。
  let index_status: any;
  try {
    await buildIndex({ vault: vaultDir, out: defaultVectorIndexPath(vaultDir) });
    index_status = { ok: true };
  } catch (e: any) {
    index_status = { ok: false, error: String(e?.message ?? e) }; // NON-FATAL
  }

  // E0 書き込み時提案: index 再構築後 (= 新ノードが索引に載った状態) に組む。
  // すべて非致命。何が失敗しても suggestions を空寄りにして返すだけで、apply は確定済み。
  const { __suggestionsInput, ...publicResult } = result as any;
  let suggestions: any;
  try {
    const sd = args.suggestDeps ?? {};
    // binding 用の index は再構築後の on-disk 索引 (新ノードが載っている)。読めなければ null。
    let suggestIndex: any = null;
    try {
      suggestIndex = await (sd.loadIndex
        ? sd.loadIndex()
        : loadVectorIndex(defaultVectorIndexPath(vaultDir)));
    } catch {
      suggestIndex = null; // 索引が読めない = 不在扱いで skip (NON-FATAL)
    }
    // embed: index ポリシー準拠の埋め込み。index 不在なら null (binding は skip 理由を返す)。
    const embed = sd.embed
      ? sd.embed
      : suggestIndex
        ? (text: string) => embedQueryForVectorIndex(text, suggestIndex)
        : null;
    let recentHitIds: string[] = [];
    try {
      recentHitIds = sd.recentHitIds ? sd.recentHitIds() : readRecentHitIds(stateDir);
    } catch {
      recentHitIds = []; // ask-state 読めずでも非致命
    }
    suggestions = await buildSuggestions({
      nextGraph: __suggestionsInput.nextGraph,
      plan: __suggestionsInput.plan,
      relations: __suggestionsInput.relations,
      vectorIndex: suggestIndex,
      embed,
      recentHitIds,
      schema: args.schema,
    });
  } catch (e: any) {
    // 想定外の失敗でも apply は確定済み。suggestions を空骨格にして返す。
    suggestions = {
      binding: { suggestions: [], skipped: `unavailable: ${String(e?.message ?? e)}` },
      relations: __suggestionsInput?.relations ?? [],
      led_to: [],
      premise_candidates: [],
      binding_debt: 0,
    };
  }

  return { ...publicResult, index_status, suggestions };
}
