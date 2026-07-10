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
import { defaultVectorIndexPath, vaultVectorIndexReadPath, loadVectorIndex } from "./retrieval.ts";
import { stateDirForVault, cacheDirUnder } from "./cli-env.ts";
import { withVaultLock, beginVaultWrite, endVaultWrite } from "./vault-lock.ts";
import {
  runDuplicateCheck,
  duplicateGateCandidates,
  duplicateGateText,
} from "./duplicate-check.ts";
import { embedForIndex } from "./vector.ts";
import { suggestBindingsForNodes } from "./suggest-policy-edges.ts";
import { countBindingDebt } from "./binding-debt.ts";
import { readRecentHitIds, resolveAskStateDir } from "./cli-ask-state.ts";
import { canonicalType, DEFAULT_SCHEMA, type SchemaDefinition } from "./schema.ts";

// export はフォールト注入テスト用 (writeVaultDelta の deps.writeFile 既定実装)。
export function writeFileAtomic(abs: string, content: string): void {
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
  sink?: { written: string[]; removed: string[]; created: string[] },
  // テスト用 DI seam: k 番目のファイル書き込みで throw させる等、実 writeVaultDelta の
  // ループ (partial sink 積み上げ含む) を踏んだまま FS 障害を注入できるようにする。
  deps?: { writeFile?: (abs: string, content: string) => void }
): { written: string[]; removed: string[]; created: string[] } {
  const writeFile = deps?.writeFile ?? writeFileAtomic;
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
      writeFile(abs, f.content);
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

/**
 * 書き込み後セルフチェック (check id: "unexplained-removal")。
 * writeVaultDelta が REMOVED したファイルは必ず「plan の node delete」か「rename
 * (ノードは nextGraph に生存していて canonical パスだけが移動した)」で説明できなければ
 * ならない。説明できない削除 = mutation ロジックが plan に無いノードを黙って落とした
 * (知識を破壊する) コードバグの兆候なので、git commit 前に throw して既存の
 * all-or-nothing rollback に乗せる。書き直し (serialization refresh / cascaded_edge_ids /
 * orphan-body cleanup はファイルの rewrite であって node ファイルの削除ではない) は
 * 対象外。削除ゼロの mutation (大多数) は id 集合の構築ごと skip する — 走るのは削除が
 * あった時だけで、ディスク IO はゼロ (in-memory の id 集合比較のみ)。
 */
export function assertRemovalsExplained(args: {
  currentGraph: { nodes?: any[] };
  nextGraph: { nodes?: any[] };
  plan: { nodes?: any[] };
  removed: string[];
}): void {
  if (args.removed.length === 0) return;
  const nextIds = new Set((args.nextGraph.nodes ?? []).map((n: any) => n.id));
  const plannedDeletes = new Set(
    (args.plan.nodes ?? [])
      .filter((n: any) => (n.op ?? "create") === "delete")
      .map((n: any) => n.id)
  );
  const lost = (args.currentGraph.nodes ?? [])
    .map((n: any) => n.id)
    .filter((id: any) => !nextIds.has(id) && !plannedDeletes.has(id));
  if (lost.length === 0) return;
  const err: any = new Error(
    `post-write self-check failed (unexplained-removal): file(s) [${args.removed.join(", ")}] were removed ` +
      `and node(s) [${lost.join(", ")}] vanished from the graph without a plan delete. This indicates a code ` +
      `bug that would silently destroy knowledge; the write is rolled back to HEAD (nothing was committed).`
  );
  err.code = "UNEXPLAINED_REMOVAL";
  err.check_id = "unexplained-removal";
  err.removed_files = [...args.removed];
  err.lost_node_ids = lost;
  throw err;
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

/**
 * vault へ staged 変更を commit する。pathspec (vault 配下だけに限定した commit) は
 * merge/cherry-pick/revert 進行中は git 側の制約で一律拒否される
 * ("cannot do a partial commit during a merge" 等。pathspec が staged 全体と一致していても
 * 中身は見ずに拒否される)。vault は通常プロジェクト repo 内に同居するので、利用者が
 * mid-merge のときに typed-add/commit-mutation を叩くと毎回ここで死んでいた。
 *
 * 判定: repo 全体の staged 一覧 (pathspec 無し) と vault 配下限定の staged 一覧
 * (pathspec "." だが cwd=vaultDir で git 自身が解決するので、macOS の /var →
 * /private/var のような symlink 起因の toplevel ズレを自前の path 計算で踏まない) を
 * 比較するだけで「vault 外に staged 済みの変更が無い」ことを検証できる。
 *   - 一致 (vault-only) → pathspec 無しで commit (mid-merge でも通る。安全性は
 *     「staged 全体が vault 配下だけ」と検証済みであることが担保する)。
 *   - 不一致 (foreign 混在) → 従来どおり pathspec 付きで commit (`--only` 相当、
 *     利用者が別所で事前 stage していた変更を巻き込まない)。mid-merge 等で git に
 *     拒否されたら、この mutation の vault 側 delta は呼び出し元が HEAD へ巻き戻す
 *     (all-or-nothing) ので、原因と取るべき行動を明示したエラーに変換して投げる。
 */
export function gitCommitVault(vaultDir: string, message: string): string {
  // git add は vaultDir を cwd にして "." で stage する。git の toplevel を
  // path.relative で求める方式は、macOS の /var → /private/var シンボリックリンク
  // 解決で root と vaultDir の prefix がずれ、"outside repository" になるため使わない。
  execFileSync("git", ["add", "--", "."], { cwd: vaultDir });

  const allStaged = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd: vaultDir,
    encoding: "utf8",
  }).trim();
  if (!allStaged) return vaultHead(vaultDir); // staged 差分ゼロ (no-op)

  const vaultStaged = execFileSync("git", ["diff", "--cached", "--name-only", "--", "."], {
    cwd: vaultDir,
    encoding: "utf8",
  }).trim();

  if (allStaged === vaultStaged) {
    // staged 全体が vault 配下だけと検証済みなので pathspec を外して commit する
    // (mid-merge でも動く形にする)。
    execFileSync("git", ["commit", "-q", "-m", message], { cwd: vaultDir });
  } else {
    try {
      execFileSync("git", ["commit", "-q", "-m", message, "--", "."], { cwd: vaultDir });
    } catch (e: any) {
      const err: any = new Error(
        `git commit failed because unrelated (non-vault) files are also staged in this repo, which ` +
          `requires a pathspec-limited commit — but git refuses pathspec-limited commits during an ` +
          `in-progress merge/cherry-pick/revert. The vault change was rolled back (all-or-nothing). ` +
          `Finish or abort the in-progress operation (e.g. \`git merge --continue\` / \`git merge --abort\`), ` +
          `or unstage/commit the unrelated files outside the vault, then retry. ` +
          `Underlying error: ${String(e?.message ?? e)}`
      );
      err.code = "PATHSPEC_COMMIT_BLOCKED";
      err.cause = e;
      throw err;
    }
  }
  return vaultHead(vaultDir);
}

// ── E0/E3/E4/E5/E6 書き込み時提案 ────────────────────────────────────────
// apply 成功後に、新規作成された知識ノードに対する suggest-only な手がかりを組む。
// すべて非致命: index/endpoint 不在は各提案を空 + reason で skip し、書き込みは決して
// 止めない (apply は既に commit 済み)。エッジは一切張らない (提案のみ)。

// binding_debt の定義 (check-carving gate #9 + Constraint 拡張と同値) は
// binding-debt.ts の countBindingDebt に一本化 (三重定義の漂流防止)。

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
      // write path の索引行は {node_id, dimensions, vector, text_hash} のみで path/title を
      // 持たない (suggest 側は best-effort で読むだけ)。候補が「どのファイルか」を id 以外で
      // 判断できるよう、nextGraph のノードから path/title/summary (先頭 100 字) を補完する。
      for (const suggestion of list) {
        for (const cand of suggestion.candidates) {
          const fileNode = nodeById.get(cand.file_id);
          if (!fileNode) continue;
          if (cand.path === undefined && typeof fileNode.path === "string") cand.path = fileNode.path;
          if (cand.title === undefined && typeof fileNode.title === "string") cand.title = fileNode.title;
          if (cand.summary === undefined && typeof fileNode.summary === "string") {
            cand.summary = fileNode.summary.slice(0, 100);
          }
        }
      }
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
  // 全て省略可: 既定は再構築後の vector index を読み、embed は index の document 空間
  // 準拠 (embedForIndex(index, text, "document"))、recentHitIds は stateDir から読む。
  // 失敗・不在は全て非致命 skip。
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
  // E1: lock / seq / ask-state は機械ローカルなので stateDir 直下ではなく cache/ に置く
  // (読み手 retrieval.loadGraph の seq 参照も cacheDirForVault で同じ場所を見る)。
  const cacheDir = cacheDirUnder(stateDir);
  // 既定の索引ビルドは buildAndWriteVectorIndex (out へ実際に書き出す版)。
  // buildVectorIndex は payload を返すだけなので直に使うと索引が更新されない。
  // vectorDeps は provider 等の DI 用 (テストで endpoint 非依存にする等)。
  const buildIndex =
    args.buildIndex ??
    ((a: { vault: string; out: string }) =>
      buildAndWriteVectorIndex({ vault: a.vault, out: a.out }, args.vectorDeps ?? {}));
  mkdirSync(cacheDir, { recursive: true });

  // plan 正規化は純粋関数なのでロック外で先に済ませる (重複ゲートの事前埋め込みが使う)。
  const plan = normalizeMutationPlan(args.plan);

  // ── 書き込み時重複ゲートの準備 (すべてロック取得前) ────────────────────────
  // 索引読み込みと候補の embedding (ネットワーク IO) をクリティカルセクションの外に
  // 出す。endpoint がハングしてもロック保持時間は writeVaultDelta + git commit のまま。
  const dupDeps = args.dupDeps ?? {};
  let dupIndex: any = null;
  try {
    dupIndex = await (dupDeps.loadIndex
      ? dupDeps.loadIndex()
      : loadVectorIndex(vaultVectorIndexReadPath(vaultDir)));
  } catch {
    dupIndex = null; // 索引が読めない = 不在扱いで skip (NON-FATAL)
  }
  // 索引と同じ document 空間で候補を埋め込む (index の prefix_policy 準拠)。索引行は
  // nodeVectorText を document 接頭辞で埋め込んだものなので、query 埋め込みで比較すると
  // 空間がずれ 0.92 閾値が系統的に甘くなる。
  const dupEmbed =
    dupDeps.embed ?? ((text: string) => embedForIndex(dupIndex, text, "document"));
  const gateCandidates = duplicateGateCandidates(plan, args.schema);
  const preEmbedded = new Map<string, number[]>();
  let preEmbedError: unknown = null;
  if (gateCandidates.length > 0 && Array.isArray(dupIndex?.rows) && dupIndex.rows.length > 0) {
    try {
      for (const candidate of gateCandidates) {
        const text = duplicateGateText(candidate);
        if (!text || preEmbedded.has(text)) continue;
        preEmbedded.set(text, await dupEmbed(text));
      }
    } catch (e) {
      preEmbedError = e; // ゲート実行時に同じ理由で skip させる (非致命)
    }
  }
  // ロック内で呼ばれる embed は事前計算の参照のみ (想定外のテキストだけ fallback で
  // 実 embed に落ちるが、候補列挙は同じ関数なので通常発生しない)。
  const gateEmbed = async (text: string): Promise<number[]> => {
    if (preEmbedError) throw preEmbedError;
    const vec = preEmbedded.get(text);
    if (vec) return vec;
    return dupEmbed(text);
  };
  // 索引の staleness: 索引再構築は post-commit 非致命なので、失敗した直後の mutation は
  // 古い索引でゲートを回すことになる。索引に打刻された vault_head と現 HEAD が違えば
  // それを正直に出力へ載せる (判定はしない: 非致命の情報提供のみ)。
  let indexStale: { index_stale: true; index_stale_reason: string } | null = null;
  if (typeof dupIndex?.vault_head === "string") {
    try {
      const currentHead = vaultHead(vaultDir);
      if (currentHead !== dupIndex.vault_head) {
        indexStale = {
          index_stale: true,
          index_stale_reason:
            `vector index was built at vault HEAD ${dupIndex.vault_head} but current HEAD is ` +
            `${currentHead} (a previous index rebuild likely failed; the duplicate gate ran on a stale index)`,
        };
      }
    } catch {
      /* vault が git でない等 → staleness 判定不能 (打刻無し扱い) */
    }
  }

  const result = await withVaultLock(cacheDir, async () => {
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
    const v = validateMutation({ currentGraph: current, plan, enforceSourceBacking: true, schema: args.schema });
    if (!v.valid) {
      const err: any = new Error("Refusing to mutate invalid graph");
      err.failures = v.failures;
      throw err;
    }

    // 書き込み時重複ゲート: lexical exact pre-pass + 既存索引との embedding 照合。
    // duplicate_ack で承認されない suspect が居れば all-or-nothing で拒否する。
    // 索引不在・embedding 不達は embedding 段のみ非致命スキップ (lexical は常に走る)。
    const dup = await runDuplicateCheck({
      plan,
      currentGraph: current,
      vectorIndex: dupIndex,
      embed: gateEmbed,
      threshold: dupDeps.threshold,
      schema: args.schema,
    });
    if (dup.failures.length > 0) {
      const err: any = new Error(
        "Refusing to create duplicate-suspect nodes (pass duplicate_ack with the existing node ids to override)"
      );
      err.code = "DUPLICATE_SUSPECT";
      err.failures = dup.failures;
      // 拒否を「壁」でなく判断材料にする: 各 suspect は既存ノードの type/title/summary/state
      // と next_step (update / supersede / --dup-ack) を同梱している。
      err.duplicate_check = {
        suspects: dup.suspects,
        cross_type_suspects: dup.cross_type_suspects,
        ...(indexStale ?? {}),
      };
      throw err;
    }
    const duplicate_check = {
      status: dup.status,
      ...(dup.reason ? { reason: dup.reason } : {}),
      suspects: dup.suspects,
      // 型跨ぎ (D↔OK / Risk↔Constraint) の重複疑い。非ブロッキング (reject に使わない)。
      cross_type_suspects: dup.cross_type_suspects,
      ...(indexStale ?? {}),
    };
    // relations は副産物 (suggest-only)。lock 外の suggestions 組み立てに渡すため保持。
    const relationCandidates = dup.relations ?? [];

    const began = beginVaultWrite(cacheDir);
    // 適用中に書いた partial をここに積む。writeVaultDelta が途中で throw しても
    // created が残るので、巻き戻しで untracked な新規ファイルを確実に消せる。
    const delta = { written: [] as string[], removed: [] as string[], created: [] as string[] };
    const writeDelta = args.writeDelta ?? writeVaultDelta;
    try {
      // commit を確定境界にするので、確定先 branch が無い(detached HEAD)なら適用前に止める。
      if (args.git !== false) assertOnBranch(vaultDir);
      writeDelta(vaultDir, v.nextGraph, delta);
      // 書き込み後セルフチェック: 説明できないファイル削除 (= plan に無い知識の消滅) を
      // commit 前に検知して throw する (下の catch で HEAD へ巻き戻る)。
      assertRemovalsExplained({ currentGraph: current, nextGraph: v.nextGraph, plan, removed: delta.removed });
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
        // 書き込み後セルフチェックの結果 (ここに到達した = 全削除が説明済み)。
        post_write_check: {
          id: "unexplained-removal",
          status: "ok",
          removed_files: delta.removed.length,
        },
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
      endVaultWrite(cacheDir, began);
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
  const sd = args.suggestDeps ?? {};
  // ask-trail 直近ヒット: premise_candidates と ask-precheck 観測 (下記) の両方が使う。
  let recentHitIds: string[] = [];
  try {
    // ask 側 (runAsk) と同じ解決関数を使う。ここを cacheDir (cacheDirUnder(stateDirForVault))
    // 決め打ちのまま読むと、GRAPHRAG_STATE_DIR を設定した環境では ask が記録した場所と
    // 書き込み側が読む場所がずれ、precheck advisory が常に「ヒット無し」の誤情報になる (#10)。
    const askStateDir = sd.recentHitIds ? null : resolveAskStateDir(vaultDir);
    recentHitIds = sd.recentHitIds ? sd.recentHitIds() : askStateDir ? readRecentHitIds(askStateDir) : [];
  } catch {
    recentHitIds = []; // ask-state 読めずでも非致命
  }
  let suggestions: any;
  try {
    // binding 用の index は再構築後の on-disk 索引 (新ノードが載っている)。読めなければ null。
    let suggestIndex: any = null;
    try {
      suggestIndex = await (sd.loadIndex
        ? sd.loadIndex()
        : loadVectorIndex(vaultVectorIndexReadPath(vaultDir)));
    } catch {
      suggestIndex = null; // 索引が読めない = 不在扱いで skip (NON-FATAL)
    }
    // embed: index の document 空間準拠の埋め込み (索引行と同じ側の接頭辞。
    // suggest-policy-edges の契約 = embedForIndex(index, text, "document") 相当)。
    // index 不在なら null (binding は skip 理由を返す)。
    const embed = sd.embed
      ? sd.embed
      : suggestIndex
        ? (text: string) => embedForIndex(suggestIndex, text, "document")
        : null;
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

  // E5 ask-precheck 観測 (advisory only): SKILL.md は知識ノード作成前の ask pre-check を
  // 求めるが、これまで何も観測していなかった。知識ノードを作る plan なのにこの state dir の
  // ask-trail が空/期限切れなら、その事実だけを非ブロッキングで duplicate_check に載せる
  // (reject には決して使わない)。
  if (gateCandidates.length > 0 && recentHitIds.length === 0 && publicResult.duplicate_check) {
    publicResult.duplicate_check = {
      ...publicResult.duplicate_check,
      precheck: {
        recent_ask_hits: recentHitIds.length,
        note:
          "No recent ask hit for this state dir in the ask-trail. Recommend confirming SKILL.md's ask pre-check " +
          "(ask for existing nodes before creating) was run (advisory only, never rejects).",
      },
    };
  }

  return { ...publicResult, index_status, suggestions };
}
