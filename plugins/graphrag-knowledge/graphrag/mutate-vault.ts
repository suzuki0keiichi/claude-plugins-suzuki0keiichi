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
import { createHash } from "node:crypto";
import path from "node:path";
import { buildVaultFiles } from "./build-vault.ts";
import { importVault, normalizeEol } from "./import-vault.ts";
import {
  normalizeMutationPlan,
  partitionIdempotentReplays,
  validateMutation,
} from "./mutation-core.ts";
import { buildAndWriteVectorIndex, vectorIndexMatchesGraph } from "./build-vector-index.ts";
import { defaultVectorIndexPath, vaultVectorIndexReadPath, loadVectorIndex } from "./retrieval.ts";
import { stateDirForVault, cacheDirUnder } from "./cli-env.ts";
import { withVaultLock, beginVaultWrite, endVaultWrite, readSeq } from "./vault-lock.ts";
import {
  runDuplicateCheck,
  duplicateGateCandidates,
  duplicateGateText,
} from "./duplicate-check.ts";
import { embedForIndex, embedManyForIndex } from "./vector.ts";
import { suggestBindingsForNodes } from "./suggest-policy-edges.ts";
import { countBindingDebt } from "./binding-debt.ts";
import { readRecentHitIds, resolveAskStateDir } from "./cli-ask-state.ts";
import { canonicalType, DEFAULT_SCHEMA, type SchemaDefinition } from "./schema.ts";
import { appendTombstones, tombstoneShardRel, TOMBSTONES_DIR, type TombstoneEntry } from "./tombstones.ts";

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
    // 失敗は呼び出し元(applyMutationToVault)へ伝播し、そちらが開始前の状態へ巻き戻す。
    try {
      unlinkSync(tmp);
    } catch {
      /* noop */
    }
    throw e;
  }
}

// ── write journal (PR #41 指摘3 / 3回目レビュー指摘1) ────────────────────────
// 「これから書く/消す予定の vault 相対パス」を writeDelta の前に cache へ永続化する。
// writer が writeDelta〜commit の間で hard crash した場合、次の writer は crash 痕跡
// (seqlock 奇数) とこの journal から「前回 writer が実際に触った可能性のあるパスだけ」を
// 吸収 stage できる (生成集合全体を stage すると crash 以前から存在した利用者 WIP まで
// 吸収してしまう)。cache/ 配下 (cli-env.ts cacheDirUnder 参照) なので消えても安全性は
// 劣化のみ: journal の無い crash 痕跡 (旧版 crash・cache 部分消去) は吸収なし (delta のみ
// stage) となり、torn 残骸は fsck の git-uncommitted (ERROR) が人手復旧を案内する。
//
// seq 打刻 (3回目レビュー指摘1): journal は「自分が属する書込窓の奇数 seq」を持つ。
// 回復側は「journal の seq === 観測している奇数 seq」の一致で今回の crash に属する
// journal だけを認め、前世代の残骸 (完了済み writer が消し損ねた journal) を次 writer の
// begin 直後 crash と誤認して無関係な記載パスを吸収することを防ぐ。seq は begin ごとに
// 単調増加 (完了 writer の奇数 O → end で O+1 → 次 begin で O+2) なので前世代の打刻と
// 偶然一致しない。
//
// 内容打刻 (敵対レビュー指摘B): journal はパス名だけでなく {path, sha256(intended)} の
// 対を持つ (v3)。intended は writeVaultDelta が書く「予定の内容」のハッシュ (削除予定は
// null = 不存在が intended)。回復側は「現 worktree 内容が intended と一致する」エントリ
// だけを前 writer の torn と認め、dirty 免除 + 吸収 stage の対象にする。不一致 (crash 後の
// 人手変更) は通常の WIP 扱い (吸収しない / DIRTY_VAULT_WIP_BLOCKED の対象) — パス名
// だけの旧 journal は crash〜回復の間の手編集を無検証で commit へ混入させていた。
// 旧形式 (v1: seq 無し / v2: paths のみ) は読めない扱い (= 吸収なしの安全劣化)。
export const VAULT_WRITE_JOURNAL = "vault.write-journal.json";

export type VaultWriteJournalEntry = {
  /** vault 相対パス (POSIX "/" 区切り) */
  path: string;
  /** 書く予定だった内容の sha256 hex。null = 削除予定 (不存在が intended) */
  sha256: string | null;
};

export function vaultWriteJournalPath(cacheDir: string): string {
  return path.join(cacheDir, VAULT_WRITE_JOURNAL);
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function readVaultWriteJournal(
  cacheDir: string
): { entries: VaultWriteJournalEntry[]; seq: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(vaultWriteJournalPath(cacheDir), "utf8"));
    if (!Array.isArray(parsed?.entries) || typeof parsed?.seq !== "number") return null;
    const entries: VaultWriteJournalEntry[] = [];
    for (const e of parsed.entries) {
      // 1 エントリでも形が崩れていたら journal 全体を不採用 (安全劣化)。部分採用すると
      // 「壊れたエントリのパスだけ検証を素通りする」抜け道になる。
      if (typeof e?.path !== "string") return null;
      if (typeof e?.sha256 !== "string" && e?.sha256 !== null) return null;
      entries.push({ path: e.path, sha256: e.sha256 });
    }
    return { entries, seq: parsed.seq };
  } catch {
    return null; // 不在/破損/旧形式 (v1/v2) = journal 無し (吸収は delta のみに劣化)
  }
}

// export はテスト用 (crash した writer が残した journal 状態の再現)。atomic (tmp+rename):
// 書き込み途中の crash で壊れた journal が残っても read 側が null に落ちて吸収が劣化する
// だけで、誤ったパス集合を吸収することは無い。seq は呼び出し元の書込窓の奇数 seq
// (beginVaultWrite の返り値)。
export function writeVaultWriteJournal(
  cacheDir: string,
  entries: VaultWriteJournalEntry[],
  seq: number
): void {
  mkdirSync(cacheDir, { recursive: true });
  const p = vaultWriteJournalPath(cacheDir);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 3, pid: process.pid, ts: Date.now(), seq, entries }));
  renameSync(tmp, p);
}

/** journal エントリの intended と現 worktree 内容の一致検証 (指摘B)。 */
function journalEntryMatchesWorktree(vaultDir: string, entry: VaultWriteJournalEntry): boolean {
  const abs = path.join(vaultDir, entry.path);
  let cur: string | null = null;
  try {
    if (existsSync(abs) && statSync(abs).isFile()) cur = readFileSync(abs, "utf8");
  } catch {
    return false; // 読めない = 検証不能 → 吸収しない (安全劣化)
  }
  if (entry.sha256 === null) return cur === null;
  return cur !== null && sha256Hex(cur) === entry.sha256;
}

/** rel の現 worktree 状態をそのまま intended として打刻したエントリ (不在は null)。 */
function worktreeStateEntry(vaultDir: string, rel: string): VaultWriteJournalEntry {
  const abs = path.join(vaultDir, rel);
  let sha: string | null = null;
  try {
    if (existsSync(abs) && statSync(abs).isFile()) sha = sha256Hex(readFileSync(abs, "utf8"));
  } catch {
    sha = null;
  }
  return { path: toPosixRel(rel), sha256: sha };
}

function clearVaultWriteJournal(cacheDir: string): void {
  try {
    unlinkSync(vaultWriteJournalPath(cacheDir));
  } catch {
    /* noop */
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
  // 途中で throw しても呼び出し元が partial を把握でき、巻き戻しで untracked な
  // 新規ファイル(created)を確実に消せる。
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

/** git の出力 (常に "/" 区切り) と比較するためのパス正規化。 */
function toPosixRel(rel: string): string {
  return rel.split(path.sep).join("/");
}

/**
 * git へ渡す pathspec を wildmatch させない (敵対レビュー指摘D)。ノードタイトル由来の
 * ファイル名は `[` `]` `*` `?` を含み得る (slugifyTitle の illegal 正規表現は落とさない)
 * ため、素のパスを pathspec に渡すと `Decision/[WIP]-foo.md` の `[WIP]` が文字クラスと
 * 解釈され、glob 一致する無関係ファイル (`Decision/W-foo.md` 等) まで stage/コミット/
 * unstage の対象になる。git add/commit/reset/ls-files へ渡す全パスはこのヘルパで
 * `:(literal)` magic を付けてリテラル一致に固定する。
 */
function literalPathspecs(paths: string[]): string[] {
  return paths.map((p) => `:(literal)${toPosixRel(p)}`);
}

/**
 * writeVaultDelta と同じ差分計算で「これから書く/消す予定の vault 相対パス」を書き込み
 * ゼロで先に求める (PR #41 再レビュー指摘2/3)。dirty 事前検査 (書く前に拒否) と write
 * journal (crash 回復の吸収範囲) の両方の基礎。呼び出しは vault lock 内なので、この予測と
 * 実書き (writeVaultDelta) の間に他 writer は入らず、集合は一致する (tombstone シャード
 * だけは recordTombstones が後段で delta に積むため呼び出し元が補う)。
 */
export function predictVaultDelta(
  vaultDir: string,
  nextGraph: any
): { written: string[]; removed: string[] } {
  const files = buildVaultFiles(nextGraph);
  const wantAbs = new Set(files.map((f) => path.join(vaultDir, f.relPath)));
  const written: string[] = [];
  for (const f of files) {
    const abs = path.join(vaultDir, f.relPath);
    const cur = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    if (cur === undefined || normalizeEol(cur) !== normalizeEol(f.content)) written.push(f.relPath);
  }
  const removed: string[] = [];
  for (const abs of listMdFiles(vaultDir)) {
    if (!wantAbs.has(abs)) removed.push(path.relative(vaultDir, abs));
  }
  return { written, removed };
}

/**
 * candidateRels のうち mutation 開始前から HEAD と差異のあるパス (staged/unstaged の
 * tracked 差分 + untracked で存在するファイル) を返す (PR #41 再レビュー指摘2)。
 * docs (graphrag-overview) は「vault の手編集は CLI を迂回するため禁止」と宣言している —
 * mutation が触る予定のパスに未コミットの手編集があると、git add がパス全体を stage する
 * ため WIP が mutation の commit に混入するか、writeVaultDelta の正規化書き直しで WIP が
 * 黙って「正史」へ昇格する。検出したら書き込み前に明示エラーで拒否する (何も書かない)。
 */
function preDirtyVaultPaths(vaultDir: string, candidateRels: string[]): string[] {
  if (candidateRels.length === 0) return [];
  const dirty = new Set<string>();
  const collect = (gitArgs: string[]) => {
    try {
      for (const p of execFileSync("git", gitArgs, { cwd: vaultDir, encoding: "utf8" }).split("\0")) {
        if (p) dirty.add(p);
      }
    } catch {
      /* unborn branch 等でその比較軸が引けない → その軸では dirty 無し扱い */
    }
  };
  // staged + unstaged の HEAD 差分 (vault 相対パス)。
  collect(["diff", "HEAD", "--name-only", "-z", "--relative", "--", "."]);
  // untracked (worktree に在るが HEAD にも index にも無い)。
  collect(["ls-files", "--others", "--exclude-standard", "-z", "--", "."]);
  return candidateRels.filter((rel) => dirty.has(toPosixRel(rel)));
}

/**
 * writeVaultDelta の直前に「これから書く/消しうるパス」の元 worktree 内容を in-memory に
 * 退避する (issue #26)。対象は生成集合 (nextGraph の全 relPath)・既存 .md 全部 (孤児削除
 * されうる)・tombstone 台帳 (追記されうる)。存在しないパスは記録しない (= 新規作成は
 * delta.created が示すので rollback は unlink で戻せる)。小さい .md 群なので軽い。
 */
function snapshotVaultPreimages(vaultDir: string, generatedRelPaths: string[]): Map<string, string> {
  const backup = new Map<string, string>();
  const record = (rel: string) => {
    if (backup.has(rel)) return;
    const abs = path.join(vaultDir, rel);
    try {
      if (existsSync(abs) && statSync(abs).isFile()) backup.set(rel, readFileSync(abs, "utf8"));
    } catch {
      /* best effort */
    }
  };
  for (const rel of generatedRelPaths) record(rel);
  for (const abs of listMdFiles(vaultDir)) record(path.relative(vaultDir, abs));
  const tombDir = path.join(vaultDir, TOMBSTONES_DIR);
  if (existsSync(tombDir)) {
    for (const e of readdirSync(tombDir)) {
      if (e.endsWith(".jsonl") || e === ".gitattributes") record(path.join(TOMBSTONES_DIR, e));
    }
  }
  return backup;
}

/**
 * apply/commit 失敗時の rollback (issue #26)。vault 全体への `git restore ... -- .` は
 * 使わない — mutation 開始前から存在した利用者の未コミット変更 (staged/unstaged) を
 * 消してしまうため。代わりに、この mutation が実際に触ったパス (delta) だけを正確に
 * 巻き戻す:
 *   - 新規作成 (created) は unlink
 *   - 上書き/削除したパスは backup (mutation 開始前の worktree 内容) を書き戻す —
 *     mutation 前が dirty ならその dirty 内容へ戻る (HEAD ではない)
 *   - index はこの mutation が stage したパス (stagedPaths) のみ HEAD へ戻す
 * 触っていないパス (利用者の既存変更含む) には一切手を付けない。best effort。
 */
function rollbackVaultWorktree(
  vaultDir: string,
  delta: { written: string[]; removed: string[]; created: string[] },
  backup: Map<string, string>,
  stagedPaths: string[] | null
): void {
  const createdSet = new Set(delta.created);
  // created は writeVaultDelta では written の部分集合だが、DI された writer が created
  // だけに積むこともあるため明示的に合流させる。
  for (const rel of new Set([...delta.written, ...delta.removed, ...delta.created])) {
    try {
      if (createdSet.has(rel)) {
        unlinkSync(path.join(vaultDir, rel));
      } else {
        const prev = backup.get(rel);
        if (prev !== undefined) writeFileAtomic(path.join(vaultDir, rel), prev);
      }
    } catch {
      /* best effort */
    }
  }
  if (stagedPaths && stagedPaths.length > 0) {
    try {
      execFileSync("git", ["reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        cwd: vaultDir,
        // 指摘D: :(literal) でリテラル一致に固定 (glob 一致する無関係ファイルを unstage しない)。
        input: literalPathspecs(stagedPaths).join("\0"),
      });
    } catch {
      /* best effort (unborn branch 等) */
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
      `bug that would silently destroy knowledge; the write is rolled back (nothing was committed).`
  );
  err.code = "UNEXPLAINED_REMOVAL";
  err.check_id = "unexplained-removal";
  err.removed_files = [...args.removed];
  err.lost_node_ids = lost;
  throw err;
}

/**
 * plan の node delete を tombstone 台帳へ記録する (issue #18)。
 * 「この ID は消えたか / いつ・なぜ / 後継はどれか / どのエッジが巻き添えになったか」を
 * 生きている vault から引けるようにする。plan.successors (validateMutation 検証済み) が
 * あれば successor として記録され、カスケードエッジは削除ノードに接していたタプルだけを
 * 各エントリへ振り分ける (修復時に「後継へ張り直す」材料になる)。
 */
function recordTombstones(args: {
  vaultDir: string;
  plan: any;
  currentGraph: { nodes?: any[] };
  cascadedEdges: any[];
  delta: { written: string[]; created: string[] };
}): { recorded: number; shards: string[] } {
  const deletes = (args.plan.nodes ?? []).filter((n: any) => (n.op ?? "create") === "delete");
  if (deletes.length === 0) return { recorded: 0, shards: [] };
  const byId = new Map((args.currentGraph.nodes ?? []).map((n: any) => [n.id, n]));
  const successorByOld = new Map(
    ((args.plan.successors ?? []) as Array<{ old: string; new: string }>).map((s) => [s.old, s.new])
  );
  const deletedAt = new Date().toISOString();
  const reason = typeof args.plan.reason === "string" && args.plan.reason ? args.plan.reason : "graphrag mutation";
  const entries: TombstoneEntry[] = deletes.map((n: any) => {
    const cur: any = byId.get(n.id);
    const cascaded = args.cascadedEdges.filter((e) => e.from === n.id || e.to === n.id);
    const entry: TombstoneEntry = { id: n.id, deleted_at: deletedAt, reason };
    if (typeof cur?.type === "string") entry.type = cur.type;
    if (typeof cur?.title === "string") entry.title = cur.title;
    const successor = successorByOld.get(n.id);
    if (successor) entry.successor = successor;
    if (cascaded.length > 0) entry.cascaded_edges = cascaded;
    return entry;
  });
  const shards = appendTombstones(args.vaultDir, entries, args.delta);
  return { recorded: entries.length, shards };
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
 * この mutation が stage してよいパス集合 (issue #26 / PR #41)。
 *
 * 通常経路 (absorbRelPaths=[]): この mutation が実際に触ったパスだけ —
 * delta.written ∪ delta.removed ∪ delta.created (tombstone シャードは appendTombstones が
 * delta に積むのでここに含まれる)。それ以外の vault 内パスは一切 stage しない。
 * vault の手編集は禁止 (docs/graphrag-overview の宣言) であり、mutation が触る予定の
 * パスに事前 dirty があれば書き込み前に拒否済み (DIRTY_VAULT_WIP_BLOCKED)、触らない
 * パスの WIP はここで stage されない — どちらの経路でも利用者の未コミット変更が
 * mutation の commit に混入しない。
 *
 * torn recovery 経路 (absorbRelPaths=前回 writer の write journal 記載パス): 前回 writer
 * の hard crash 痕跡 (seqlock 奇数) を検出し、かつ journal が読めた場合のみ、その journal
 * 記載パス (= 前回 writer が実際に触った可能性のある集合) へ広げる。生成集合全体では
 * ない — 生成集合には crash 以前から存在した利用者 WIP (canonical 手編集で dirty のまま
 * のパス) も含まれ、丸ごと stage するとそれを吸収してしまう (再レビュー指摘3)。
 *
 * 存在しないパス (削除済み) は tracked のものだけ残す — untracked だった孤児 .md の削除は
 * git 的に無で、pathspec が何にもマッチしないと git add が失敗するため。
 */
function mutationStagePaths(
  vaultDir: string,
  absorbRelPaths: string[],
  delta: { written: string[]; removed: string[]; created: string[] }
): string[] {
  const all = new Set<string>([
    ...absorbRelPaths,
    ...delta.written,
    ...delta.removed,
    // created は writeVaultDelta では written の部分集合だが、DI writer が created だけに
    // 積む可能性に備え rollback 側 (rollbackVaultWorktree) と同様に明示的に合流させる。
    ...delta.created,
  ]);
  const out: string[] = [];
  const missing: string[] = [];
  for (const rel of all) {
    if (existsSync(path.join(vaultDir, rel))) out.push(rel);
    else missing.push(rel);
  }
  if (missing.length > 0) {
    // 指摘D: :(literal) でリテラル一致に固定 (glob 一致する無関係な tracked ファイルを
    // stage 対象に混入させない)。
    const tracked = execFileSync("git", ["ls-files", "-z", "--", ...literalPathspecs(missing)], {
      cwd: vaultDir,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean);
    out.push(...tracked);
  }
  return out;
}

/**
 * 進行中の git operation を返す (無ければ null)。進行中の index/worktree は「その
 * operation の解決状態」そのもので、commit は operation 全体の確定 (または混線) を
 * 意味する — しかも operation の結果と、開始後に利用者が stage した WIP は index から
 * 区別できない。mutation がそれを暗黙確定するのは操作境界を越える (PR #41 3回目
 * レビュー指摘2) ため、applyMutationToVault は何も書く前の最上流でこの検出を引いて
 * OPERATION_IN_PROGRESS_BLOCKED として拒否する (assertNoGitOperationInProgress)。
 *
 * 検出対象 (敵対レビュー指摘F で拡充): merge/cherry-pick/revert に加え、
 *  - rebase (rebase-merge / rebase-apply ディレクトリ。conflict 停止中は detached HEAD
 *    でもあるが、DETACHED_HEAD より先にこちらで具体的な operation 名を返す)
 *  - git am (rebase-apply/applying マーカーで rebase と区別)
 *  - bisect (BISECT_LOG。HEAD が branch 上のままでも探索途中の commit 追加は bisect の
 *    履歴仮定を乱す)
 *  - squash merge 未確定 (SQUASH_MSG。staged の squash 結果を mutation の commit が
 *    自分の reason で確定してしまう)
 */
function operationInProgress(
  vaultDir: string
): { op: string; finish: string; abort: string } | null {
  const gitPath = (marker: string): string | null => {
    try {
      const p = execFileSync("git", ["rev-parse", "--git-path", marker], {
        cwd: vaultDir,
        encoding: "utf8",
      }).trim();
      return path.isAbsolute(p) ? p : path.join(vaultDir, p);
    } catch {
      return null; /* repo で無い等 → 進行中扱いしない */
    }
  };
  const present = (marker: string): string | null => {
    const p = gitPath(marker);
    return p !== null && existsSync(p) ? p : null;
  };
  if (present("MERGE_HEAD")) return { op: "merge", finish: "merge --continue", abort: "merge --abort" };
  if (present("CHERRY_PICK_HEAD")) {
    return { op: "cherry-pick", finish: "cherry-pick --continue", abort: "cherry-pick --abort" };
  }
  if (present("REVERT_HEAD")) return { op: "revert", finish: "revert --continue", abort: "revert --abort" };
  if (present("rebase-merge")) return { op: "rebase", finish: "rebase --continue", abort: "rebase --abort" };
  const rebaseApply = present("rebase-apply");
  if (rebaseApply) {
    // rebase-apply は apply backend の rebase と git am の共用ディレクトリ。
    // applying マーカーが在れば git am。
    if (existsSync(path.join(rebaseApply, "applying"))) {
      return { op: "am", finish: "am --continue", abort: "am --abort" };
    }
    return { op: "rebase", finish: "rebase --continue", abort: "rebase --abort" };
  }
  if (present("BISECT_LOG")) {
    return { op: "bisect", finish: "bisect reset (when the bisection is done)", abort: "bisect reset" };
  }
  if (present("SQUASH_MSG")) {
    return {
      op: "squash-merge",
      finish: "commit (to conclude the squashed merge yourself)",
      abort: "reset --merge",
    };
  }
  return null;
}

/**
 * mutation の最上流ゲート (PR #41 3回目レビュー指摘2 / 敵対レビュー指摘F): git operation
 * 進行中は何も書く前 (beginVaultWrite / journal 書込みより前) に明示エラーで拒否する。
 * 何も書いていないので rollback は不要。利用者には進行中 operation の完了か中止を案内する。
 */
function assertNoGitOperationInProgress(vaultDir: string): void {
  const found = operationInProgress(vaultDir);
  if (!found) return;
  const err: any = new Error(
    `refusing to mutate: a git ${found.op} is in progress in the repository containing the vault. ` +
      `Committing the mutation now would entangle it with that operation's unfinished state — ` +
      `its staged/worktree result is indistinguishable from anything staged since it began. ` +
      `Nothing was written. Finish or abort it first (\`git -C ${vaultDir} ${found.finish}\`, or ` +
      `\`git -C ${vaultDir} ${found.abort}\`), then retry.`
  );
  err.code = "OPERATION_IN_PROGRESS_BLOCKED";
  err.operation = found.op;
  throw err;
}

/**
 * vault へ mutation の差分を stage して commit する。stage は vault 全体 (`git add -- .`)
 * ではなく stagePaths (mutationStagePaths が決めた明示 pathspec — 通常は delta 触接パス
 * のみ、crash 痕跡検出時のみ前回 writer の write journal 記載パス) に限定する
 * (issue #26 / PR #41) — 利用者が vault 内に持つ生成集合外の未コミット変更 (手編集
 * ファイル等) を勝手に commit へ混入させないため。stage されなかった変更が vault subtree
 * に dirty のまま残るのは正しい挙動 (fsck の git-uncommitted check が可視化する)。
 *
 * 事前 staged WIP の拒否 (PR #41 再レビュー指摘1): 従来の allStaged === vaultStaged 判定は
 * 「staged 全体が vault 配下に収まっているか」しか見ず、利用者が vault 内で事前に stage
 * していた WIP を pathspec 無し commit が mutation の reason で丸ごと確定していた
 * (stagePaths が空でも同様)。git add の前に vault 配下の staged 集合をスナップショットし、
 * stagePaths に含まれないものが居れば明示エラーで拒否する (呼び出し元が vault 側 delta を
 * rollback する。利用者の staged WIP には手を付けない)。例外は無い — かつて存在した
 * mid-merge 免除 (merge の staged 結果は stagePaths 外に見えるため) は、mid-merge 中の
 * mutation 自体を applyMutationToVault が最上流で拒否する形 (3回目レビュー指摘2:
 * OPERATION_IN_PROGRESS_BLOCKED) に置き換えて廃止した。
 *
 * commit 形式 (敵対レビュー指摘E): commit は常に stagePaths 限定の pathspec 付き
 * (`--only` 相当、指摘D の :(literal) 付き)。かつて「repo 全体の staged 一覧 (allStaged)
 * と vault 配下限定の staged 一覧 (vaultStaged) が一致すれば pathspec 無し commit」に
 * 落としていたが、pathspec 無し commit は preStaged スナップショットと commit の間に
 * stage された変更 (TOCTOU) を丸ごと mutation の reason で確定してしまう。foreign 保護は
 * 検査として維持する: vault 外の staged は pathspec commit が構造的に巻き込まず、vault 内
 * で stagePaths 外が staged になっていれば (スナップショット後の stage) add 後の再検査が
 * 明示エラーで拒否する。git が pathspec 付き commit を拒否する状況 (merge/cherry-pick/
 * revert 進行中の partial commit) は最上流の OPERATION_IN_PROGRESS_BLOCKED が先に塞いで
 * いるため、ここでの失敗は hook 失敗等の素の異常 — そのまま伝播させ、呼び出し元が
 * vault 側 delta を巻き戻す (all-or-nothing)。
 *
 * staged 一覧の取得はいずれも cwd=vaultDir で git 自身にパス解決させる (macOS の /var →
 * /private/var のような symlink 起因の toplevel ズレを自前の path 計算で踏まない)。
 */
export function gitCommitVault(vaultDir: string, message: string, stagePaths: string[]): string {
  // PR #41 再レビュー指摘1: git add の「前」に vault 配下の事前 staged 集合を取る。
  // ここに stagePaths 外のパスが居る = 利用者 (または別プロセス) の未確定 WIP であり、
  // このまま進むと pathspec 無し commit がそれを mutation の reason で確定してしまう。
  const preStaged = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "-z", "--relative", "--", "."],
    { cwd: vaultDir, encoding: "utf8" }
  )
    .split("\0")
    .filter(Boolean);
  const stageSet = new Set(stagePaths.map(toPosixRel));
  const preStagedForeign = preStaged.filter((p) => !stageSet.has(p));
  if (preStagedForeign.length > 0) {
    const err: any = new Error(
      `refusing to commit: the vault has pre-staged uncommitted changes that are not part of this ` +
        `mutation [${preStagedForeign.join(", ")}]. Committing now would absorb them under this ` +
        `mutation's reason. The vault change was rolled back (all-or-nothing). Commit them yourself or ` +
        `unstage them (e.g. \`git -C ${vaultDir} restore --staged -- <path>\`), then retry.`
    );
    err.code = "PRESTAGED_WIP_BLOCKED";
    err.prestaged_paths = preStagedForeign;
    throw err;
  }

  // git add は vaultDir を cwd にし、pathspec は stdin (NUL 区切り) で渡す (パス数が
  // 多くても ARG_MAX を踏まない)。git の toplevel を path.relative で求める方式は、
  // macOS の /var → /private/var シンボリックリンク解決で root と vaultDir の prefix が
  // ずれ、"outside repository" になるため使わない。pathspec は :(literal) 固定 (指摘D)。
  if (stagePaths.length > 0) {
    execFileSync("git", ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      cwd: vaultDir,
      input: literalPathspecs(stagePaths).join("\0"),
    });
  }

  const allStaged = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd: vaultDir,
    encoding: "utf8",
  }).trim();
  if (!allStaged) return vaultHead(vaultDir); // staged 差分ゼロ (no-op)

  // foreign 保護検査 (指摘E で維持): vault 配下の staged を再取得し、stagePaths 外が
  // 居れば preStaged スナップショット後に stage された WIP (TOCTOU)。pathspec commit は
  // それを巻き込まないが、巻き込み前に明示エラーで拒否して利用者に見せる (第一検査
  // preStaged と同じ意図の第二防壁)。vault 外の staged (allStaged と vaultStaged の差) は
  // 拒否しない — stagePaths 限定 pathspec commit が構造的に巻き込まない。
  const vaultStaged = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "-z", "--relative", "--", "."],
    { cwd: vaultDir, encoding: "utf8" }
  )
    .split("\0")
    .filter(Boolean);
  const lateStaged = vaultStaged.filter((p) => !stageSet.has(p));
  if (lateStaged.length > 0) {
    const err: any = new Error(
      `refusing to commit: path(s) inside the vault were staged while this mutation was running ` +
        `[${lateStaged.join(", ")}]. Committing without rejecting could associate them with this ` +
        `mutation's reason. The vault change was rolled back (all-or-nothing). Commit them yourself or ` +
        `unstage them (e.g. \`git -C ${vaultDir} restore --staged -- <path>\`), then retry.`
    );
    err.code = "PRESTAGED_WIP_BLOCKED";
    err.prestaged_paths = lateStaged;
    throw err;
  }

  // stagePaths 側に staged 差分が無ければ no-op (従来の「staged 差分ゼロ」早期 return と
  // 整合: pathspec commit は空だと "no changes" で失敗するため、ここで確定的に返す)。
  if (vaultStaged.length === 0) return vaultHead(vaultDir);

  // 指摘E: commit は常に stagePaths 限定の pathspec 付き。pathspec 付き commit は
  // 「listed files の現在内容」を記録するので、pathspec を "." にすると利用者の unstaged
  // な vault 内編集まで記録してしまう — この mutation の stagePaths に限定する (それらの
  // worktree 内容 = この mutation が書いた内容)。:(literal) でリテラル一致に固定 (指摘D)。
  execFileSync(
    "git",
    ["commit", "-q", "-m", message, "--pathspec-from-file=-", "--pathspec-file-nul"],
    {
      cwd: vaultDir,
      input: literalPathspecs(stagePaths).join("\0"),
    }
  );
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
  // issue #31: 複数ノードをバッチで埋め込む口 (省略時は embed の直列 fallback)。
  embedMany?: ((texts: string[]) => Promise<number[][]>) | null;
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
        ...(args.embedMany ? { embedMany: args.embedMany } : {}),
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
 * issue #27: 重複ゲートが使った索引の staleness 判定。
 * 主判定は graph/index の内容突合 (vectorIndexMatchesGraph) — 手元の currentGraph と
 * rows の node 集合 + text_hash が一致すれば fresh (vault_head が食い違っていても、
 * head は dirty vault / 並行 build で嘘をつくので信じない)。text_hash を持たない
 * 旧形式 index は内容で判定できないので、head 比較の fallback (headStale) に落とす。
 * 非致命の情報提供のみ (判定で mutation は止めない)。
 */
function assessIndexStale(
  currentGraph: any,
  dupIndex: any,
  headStale: { index_stale: true; index_stale_reason: string } | null
): { index_stale: true; index_stale_reason: string } | null {
  const contentJudgeable =
    Array.isArray(dupIndex?.rows) &&
    dupIndex.rows.length > 0 &&
    dupIndex.rows.every((row: any) => typeof row?.text_hash === "string");
  if (!contentJudgeable) return headStale;
  if (vectorIndexMatchesGraph(currentGraph, dupIndex)) return null;
  return {
    index_stale: true,
    index_stale_reason:
      "vector index content does not match the current graph (node set / text hashes diverge — " +
      "a previous index rebuild likely failed or lost a race; the duplicate gate ran on a stale index)",
  };
}

/**
 * vault への mutation 適用一式を lock 内で実行する。
 * 流れ: lock → OCC(base_sha vs HEAD) → import → normalize/validate → 重複ゲート(非致命 skip 可) →
 * seq begin → on-branch 保証 → writeVaultDelta → 索引再構築(非致命) → git commit → seq end。
 * 索引(vector.json)は再生成可能な二次成果物なので、ビルド失敗しても
 * mutation は中断せず commit まで進め index_status で結果を返す。
 * 原子性: git commit(ref 前進)を唯一の確定境界とし、適用中のどの失敗(writeVaultDelta
 * 途中失敗・commit 失敗)でも「この mutation が触ったパスだけ」を開始前の worktree 内容へ
 * 巻き戻す (issue #26: vault 全体の HEAD restore は利用者の未コミット変更を消すのでしない)。
 * 外から見える正本 (committed) 状態は常に「古い HEAD」か「新しい HEAD」だけになり、
 * base_sha↔HEAD の OCC が実際に効く。stage/commit も明示 pathspec (通常は delta 触接
 * パスのみ、crash 痕跡 = seq 奇数の検出時のみ前回 writer の write journal 記載パス) に
 * 限定し、さらに「mutation が触る予定のパスの事前 dirty」(DIRTY_VAULT_WIP_BLOCKED) と
 * 「vault 配下の事前 staged WIP」(PRESTAGED_WIP_BLOCKED) は明示エラーで拒否して、
 * 利用者の未コミット変更を commit へ混入させない (PR #41 再レビュー指摘1〜3)。
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
    // issue #31: 候補群をバッチで埋め込む口 (省略時: embed 指定なら直列 fallback、
    // どちらも無ければ embedManyForIndex の既定バッチ経路)。返却順は texts 順。
    embedMany?: (texts: string[]) => Promise<number[][]>;
    threshold?: number;
  };
  // E0 書き込み時提案の DI (binding 用 index/embed と ask-trail base dir)。
  // 全て省略可: 既定は再構築後の vector index を読み、embed は index の document 空間
  // 準拠 (embedForIndex(index, text, "document"))、recentHitIds は stateDir から読む。
  // 失敗・不在は全て非致命 skip。
  suggestDeps?: {
    loadIndex?: () => Promise<any> | any;
    embed?: (text: string) => Promise<number[]>;
    // issue #31: binding 埋め込みのバッチ口 (省略時: embed 指定なら直列 fallback、
    // どちらも無ければ embedManyForIndex の既定バッチ経路)。返却順は texts 順。
    embedMany?: (texts: string[]) => Promise<number[][]>;
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
  // 破損索引 (loadVectorIndex の parse 失敗 Error 等)。索引は二次生成物なので
  // mutation はブロックしない (不在扱いで skip) が、無音にせず duplicate_check に
  // note (index_corrupt) を残す (issue #30: 無音縮退の解消)。
  let indexCorrupt: { index_corrupt: true; index_corrupt_reason: string } | null = null;
  try {
    dupIndex = await (dupDeps.loadIndex
      ? dupDeps.loadIndex()
      : loadVectorIndex(vaultVectorIndexReadPath(vaultDir)));
  } catch (e: any) {
    dupIndex = null; // 不在扱いで skip (NON-FATAL)
    indexCorrupt = {
      index_corrupt: true,
      index_corrupt_reason:
        `vector index unreadable — the duplicate gate ran without it: ${String(e?.message ?? e)}`,
    };
  }
  // 索引と同じ document 空間で候補を埋め込む (index の prefix_policy 準拠)。索引行は
  // nodeVectorText を document 接頭辞で埋め込んだものなので、query 埋め込みで比較すると
  // 空間がずれ 0.92 閾値が系統的に甘くなる。
  const dupEmbed =
    dupDeps.embed ?? ((text: string) => embedForIndex(dupIndex, text, "document"));
  // issue #31: 事前埋め込みは候補群を 1 バッチ (チャンク直列) で送る。DI が単発 embed
  // のみ指定した場合はその embed の直列 fallback (テスト互換)。
  const dupEmbedMany: (texts: string[]) => Promise<number[][]> =
    dupDeps.embedMany
      ?? (dupDeps.embed
        ? async (texts: string[]) => {
            const out: number[][] = [];
            for (const text of texts) out.push(await dupEmbed(text));
            return out;
          }
        : (texts: string[]) => embedManyForIndex(dupIndex, texts, "document"));
  const gateCandidates = duplicateGateCandidates(plan, args.schema);
  const preEmbedded = new Map<string, number[]>();
  let preEmbedError: unknown = null;
  if (gateCandidates.length > 0 && Array.isArray(dupIndex?.rows) && dupIndex.rows.length > 0) {
    try {
      const texts: string[] = [];
      const seenTexts = new Set<string>();
      for (const candidate of gateCandidates) {
        const text = duplicateGateText(candidate);
        if (!text || seenTexts.has(text)) continue;
        seenTexts.add(text);
        texts.push(text);
      }
      if (texts.length > 0) {
        const vectors = await dupEmbedMany(texts);
        if (!Array.isArray(vectors) || vectors.length !== texts.length) {
          throw new Error(
            `embedMany returned ${Array.isArray(vectors) ? vectors.length : "no"} vector(s) for ${texts.length} text(s)`
          );
        }
        texts.forEach((text, i) => preEmbedded.set(text, vectors[i]));
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
  // バッチ版 (runDuplicateCheck へ渡す): 事前計算の参照が基本。miss 分だけまとめて
  // dupEmbedMany に落とす (候補列挙は同じ関数なので通常 miss は発生しない)。
  const gateEmbedMany = async (texts: string[]): Promise<number[][]> => {
    if (preEmbedError) throw preEmbedError;
    const out: number[][] = new Array(texts.length);
    const missTexts: string[] = [];
    const missAt: number[] = [];
    texts.forEach((text, i) => {
      const vec = preEmbedded.get(text);
      if (vec) out[i] = vec;
      else {
        missTexts.push(text);
        missAt.push(i);
      }
    });
    if (missTexts.length > 0) {
      const vectors = await dupEmbedMany(missTexts);
      missAt.forEach((at, j) => {
        out[at] = vectors[j];
      });
    }
    return out;
  };
  // 索引の staleness (fallback 側): 索引再構築は post-commit 非致命なので、失敗した直後の
  // mutation は古い索引でゲートを回すことになる。索引に打刻された vault_head と現 HEAD が
  // 違えばそれを正直に出力へ載せる (判定はしない: 非致命の情報提供のみ)。
  // issue #27: head 比較はここでは fallback に格下げ — 主判定はロック内で graph を読んだ後の
  // 内容突合 (vectorIndexMatchesGraph)。head は dirty vault / 並行 build で rows と別 snapshot を
  // 指し得る (rows は working tree 由来・head は git 由来) ので、text_hash を持たない旧形式
  // index のときだけこの head 比較を使う。
  let headStaleFallback: { index_stale: true; index_stale_reason: string } | null = null;
  if (typeof dupIndex?.vault_head === "string") {
    try {
      const currentHead = vaultHead(vaultDir);
      if (currentHead !== dupIndex.vault_head) {
        headStaleFallback = {
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
    // PR #41 3回目レビュー指摘2: merge/cherry-pick/revert 進行中は mutation 全体を
    // 何も書く前の最上流で拒否する。進行中の index は operation の解決状態そのもので、
    // この mutation の commit が operation 全体を暗黙確定してしまう (operation の結果と
    // 開始後に利用者が stage した WIP は index から区別できない)。何も書いていないので
    // rollback は不要。
    if (args.git !== false) {
      assertNoGitOperationInProgress(vaultDir);
      // 敵対レビュー指摘F: detached HEAD の検出 (assertOnBranch) も beginVaultWrite /
      // journal 書込みより前の最上流で行う。旧位置 (writeDelta 直前、書込窓を開いた後)
      // では失敗が finally の journal/seq 処理と結合し、crash residue の回復材料を危険に
      // 晒していた。rebase 進行中 (detached でもある) はこの手前の
      // OPERATION_IN_PROGRESS_BLOCKED が具体的な operation 名で先に拒否する。
      assertOnBranch(vaultDir);
    }
    const current = importVault(vaultDir);
    // issue #27: 索引 staleness の主判定 — 手元に graph (current) があるので、head 比較では
    // なく内容突合 (vectorIndexMatchesGraph: node 集合 + text_hash) で判定する。索引の
    // vault_head は並行 build / dirty vault で rows と別 snapshot を指し得る (嘘をつく) が、
    // 内容突合は「今ゲートが使った索引がこの graph を表しているか」を直接答える。
    // text_hash を持たない旧形式 index はロック外で計算した head 比較 fallback に落とす。
    const indexStale = assessIndexStale(current, dupIndex, headStaleFallback);
    // 冪等リプレイの吸収 (issue #24): 同一内容の op:create 再送 (タイムアウト後の
    // リトライ等) は「既に成功した書き込み」なので失敗にしない。plan 全体が再送なら
    // 書き込み自体を skip して成功を返す (連打を毒にしない)。
    const partitioned = partitionIdempotentReplays(plan, current);
    const effectivePlan = partitioned.plan;
    const idempotent_replay =
      partitioned.replayedNodeIds.length > 0 || partitioned.replayedEdgeIds.length > 0
        ? {
            nodes: partitioned.replayedNodeIds,
            edges: partitioned.replayedEdgeIds,
            note:
              "These op:create items already exist with identical content — treated as successful no-op replays " +
              "(safe retry). Nothing was written for them.",
          }
        : null;
    if (effectivePlan.nodes.length === 0 && effectivePlan.edges.length === 0) {
      let head: string | null = null;
      try {
        head = args.git !== false ? vaultHead(vaultDir) : null;
      } catch {
        head = null;
      }
      return {
        applied: true,
        head,
        idempotent_replay,
        files: { written: [], removed: [], created: [] },
        changed_nodes: { created: [], updated: [], deleted: [] },
        note: "entire plan was an idempotent replay — vault already contains this content; no commit was made",
        __replayOnly: true,
      };
    }
    // OCC: base_sha が現 HEAD と違えば「古い判断」として拒否（粗い粒度）。
    // 冪等リプレイ吸収の後に置く (レビュー指摘): base_sha 付き再送の代表例は「1回目が
    // commit 済みで HEAD が進んだ後のタイムアウト・リトライ」で、まさに base_sha が古く
    // なっているケース。全量リプレイは vault が既にこの内容を含むので stale 判断の懸念
    // 自体が無く、先に OCC を引くと吸収できない。残作業がある場合のみ従来どおり検査する。
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
    const v = validateMutation({ currentGraph: current, plan: effectivePlan, enforceSourceBacking: true, schema: args.schema });
    if (!v.valid) {
      const err: any = new Error("Refusing to mutate invalid graph");
      err.failures = v.failures;
      throw err;
    }
    // 未知の属性名は WARN 止まり (issue #20): 意図的なモデル外キー運用を壊さないため
    // reject しないが、typo (summary_append 等) にその場で気付けるよう結果に同梱する。
    const attribute_check = {
      status: (v.attributeWarnings?.length ?? 0) > 0 ? "warn" : "ok",
      warnings: v.attributeWarnings ?? [],
    };

    // 書き込み時重複ゲート: lexical exact pre-pass + 既存索引との embedding 照合。
    // duplicate_ack で承認されない suspect が居れば all-or-nothing で拒否する。
    // 索引不在・embedding 不達は embedding 段のみ非致命スキップ (lexical は常に走る)。
    const dup = await runDuplicateCheck({
      plan: effectivePlan,
      currentGraph: current,
      vectorIndex: dupIndex,
      embed: gateEmbed,
      embedMany: gateEmbedMany,
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
        ...(indexCorrupt ?? {}),
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
      ...(indexCorrupt ?? {}),
    };
    // relations は副産物 (suggest-only)。lock 外の suggestions 組み立てに渡すため保持。
    const relationCandidates = dup.relations ?? [];

    // PR #41: torn recovery の判別。前回 writer の hard crash は seqlock の奇数 seq を
    // 必ず残す (endVaultWrite は withVaultLock 内の finally で commit 後に走るので、
    // kill -9 なら seq は奇数のまま)。いまロックは自分が保持していて並行 writer は
    // 居ないから、自分の beginVaultWrite より前のこの時点で seq 奇数 = crash 痕跡と
    // 確定できる。この場合のみ stage を「前回 writer の write journal 記載パスのうち
    // 内容検証 (指摘B: 現 worktree = intended) を通ったもの」へ広げ、前回の torn ファイル
    // (内容一致で delta に載らない dirty ノード .md) を今回の commit に吸収して自己回復
    // する (再レビュー指摘3: 生成集合全体を吸収すると crash 以前から存在した利用者 WIP
    // まで巻き込むため journal に限定)。通常経路 (seq 偶数) では delta 触接パスだけを
    // stage し、利用者の未コミット WIP を commit に混入させない。
    // 許容劣化: cache/ を丸ごと消す運用 (cli-env.ts cacheDirUnder: 「cache/ は消して
    // 安全、vault.seq のリセットは設計上許容」) で crash 痕跡を失った後の torn、および
    // journal を持たない crash 痕跡 (journal 導入前の旧版 crash・cache 部分消去) は
    // 自己回復しない (後者は delta のみ stage) — どちらも fsck の git-uncommitted
    // (ERROR) が検知して人手復旧を案内する。
    //
    // seq 打刻の突合 (3回目レビュー指摘1): journal は自分が属する書込窓の奇数 seq を
    // 打刻している。「journal の seq === いま観測している奇数 seq」の場合のみ今回の
    // crash に属する journal と認める。seq は begin ごとに単調増加 (完了 writer の奇数
    // O → end で O+1 → 次 begin で O+2) なので、前世代の残骸 journal (完了済み writer
    // が消し損ねたもの) と偶然一致することは無い。二重 crash の再入 (beginVaultWrite は
    // 既奇数なら据え置き) では同じ奇数のまま merge されるので一致し続ける。不一致は
    // journal 無しと同じ安全劣化 (吸収なし、fsck の git-uncommitted が人手復旧を案内)。
    const observedSeq = readSeq(cacheDir);
    const crashResidue = observedSeq % 2 === 1;
    const journalOnDisk = crashResidue ? readVaultWriteJournal(cacheDir) : null;
    const priorJournal = journalOnDisk && journalOnDisk.seq === observedSeq ? journalOnDisk : null;
    // 敵対レビュー指摘B: journal 記載は {path, sha256(intended)}。現 worktree 内容が
    // intended と一致するエントリだけを「前 writer の torn」と認め、dirty 免除 + 吸収
    // stage の対象にする。不一致 (crash〜回復の間の人手変更) は通常の WIP 扱い —
    // 吸収せず、mutation が触るパスなら DIRTY_VAULT_WIP_BLOCKED で拒否する。
    // 削除予定 (sha256: null) は「不存在」が一致。検証は writeDelta 前のこの時点
    // (worktree がまだ前 writer の残した状態) で行う。
    const verifiedPriorPaths = priorJournal
      ? [
          ...new Set(
            priorJournal.entries
              .filter((e) => journalEntryMatchesWorktree(vaultDir, e))
              .map((e) => toPosixRel(e.path))
          ),
        ]
      : [];
    // 指摘B の前提: buildVaultFiles を決定的にする。新規ノードの banner timestamp は
    // node.generated_at → graph.generated_at → 呼び出し毎の now() の順で fallback する
    // ため、graph-level stamp が無いと「journal に打刻した intended」(この呼び出し) と
    // 「writeVaultDelta が実際に書く内容」(別呼び出し) のハッシュが ms 差でずれ、torn の
    // 内容検証が恒久に失敗する。ここで一度だけ stamp を固定し、以後の全 buildVaultFiles
    // (predict / journal / writeDelta) を同一内容にする。
    if (!v.nextGraph.generated_at) v.nextGraph.generated_at = new Date().toISOString();
    // issue #26 / PR #41: 生成集合 (nextGraph の全 relPath) は preimage backup の基礎。
    // backup は writeVaultDelta の直前に取り、失敗時の rollback は「この mutation が
    // 触ったパスだけ」を mutation 開始前の worktree 内容へ戻す (利用者の未コミット変更に
    // 手を付けない)。content は journal の intended 打刻 (指摘B) にも使う。
    const generatedFiles = buildVaultFiles(v.nextGraph) as Array<{ relPath: string; content: string }>;
    const generatedRelPaths = generatedFiles.map((f) => f.relPath);
    const generatedContentByRel = new Map(generatedFiles.map((f) => [f.relPath, f.content]));
    // 再レビュー指摘2/3: これから触る予定のパス (writeVaultDelta と同じ差分計算 +
    // delete 時に recordTombstones が書く tombstone シャード)。dirty 事前拒否と write
    // journal の両方の基礎。シャードは月単位なので実書き時とほぼ常に一致する (月境界を
    // 跨いだ直後だけ journal から漏れうるが、その劣化は「吸収されない torn シャードを
    // fsck が案内する」に留まる)。.gitattributes は不在時のみ新規作成される (既存なら
    // recordTombstones は触らないので dirty 判定にも journal にも載せない)。
    const predicted = predictVaultDelta(vaultDir, v.nextGraph);
    const hasDeletes = (effectivePlan.nodes ?? []).some((n: any) => (n.op ?? "create") === "delete");
    const tombstoneRels: string[] = [];
    if (hasDeletes) {
      tombstoneRels.push(tombstoneShardRel(new Date().toISOString()));
      if (!existsSync(path.join(vaultDir, TOMBSTONES_DIR, ".gitattributes"))) {
        tombstoneRels.push(path.join(TOMBSTONES_DIR, ".gitattributes"));
      }
    }
    const predictedTouch = [...new Set([...predicted.written, ...predicted.removed, ...tombstoneRels])];
    // 再レビュー指摘2: mutation が触る予定のパスに mutation 開始前からの未コミット変更
    // (手編集 WIP) があれば、何も書かずに明示エラーで拒否する。vault の手編集は禁止
    // (docs の宣言 — preDirtyVaultPaths のコメント参照)。crash 痕跡時は前回 journal の
    // 内容検証済みパス (指摘B: 現 worktree = intended) だけを免除する — torn ファイルは
    // 定義上 dirty であり、免除しないと torn ノードを二度と mutate できないデッドロック
    // になる。検証に落ちたパス (人手変更) は免除しない。
    if (args.git !== false) {
      const exempt = new Set(verifiedPriorPaths);
      const dirty = preDirtyVaultPaths(
        vaultDir,
        predictedTouch.filter((rel) => !exempt.has(toPosixRel(rel)))
      );
      if (dirty.length > 0) {
        const err: any = new Error(
          `refusing to mutate: the vault has uncommitted manual changes on path(s) this mutation would ` +
            `write or remove [${dirty.join(", ")}]. Hand-editing the vault is unsupported (it bypasses ` +
            `the CLI) and committing now would absorb or normalize away that WIP. Nothing was written. ` +
            `Inspect with \`git -C ${vaultDir} status\`, then commit the changes yourself or discard ` +
            `them (\`git -C ${vaultDir} restore -- <path>\`), and retry.`
        );
        err.code = "DIRTY_VAULT_WIP_BLOCKED";
        err.dirty_paths = dirty;
        throw err;
      }
    }
    const began = beginVaultWrite(cacheDir);
    // 再レビュー指摘3: writeDelta の「前」に write journal を永続化する (直後に hard
    // crash しても「触った可能性のあるパス」が残り、次の writer が吸収範囲を限定できる)。
    // crash 痕跡がある場合は前回 journal と merge する — beginVaultWrite は既奇数なら
    // 据え置く再入設計のため、二重 crash では両 writer のエントリを合算した journal が
    // 次の回復に渡る。このとき began は前回と同じ奇数のままなので、打刻 seq (指摘1) も
    // 一致し続け、merge された journal は引き続き有効な回復材料になる。削除/書き戻しは
    // finally (書込窓が閉じる時、endVaultWrite より前) で行う。
    //
    // 指摘B: エントリは {path, sha256(intended)}。書く予定のパスは生成内容のハッシュ、
    // 消す予定のパスは null (不存在が intended)。tombstone 系 (シャード + 初回
    // .gitattributes) は内容が recordTombstones 実行時 (追記 + 実時刻) まで確定しない
    // ため、まず「書込前のディスク状態」を打刻し (crash が追記前なら一致 = 吸収 no-op、
    // 追記後は不一致 = 吸収なしの安全劣化)、recordTombstones 完了後に実内容で更新する。
    // 前世代エントリはそのまま残す — 同一パスに複数エントリがあっても「どれか一つの
    // intended に一致すれば torn」で検証できる (前 writer 版 / 自分版のどちらで crash
    // しても回復可能)。
    const ourJournalEntries: VaultWriteJournalEntry[] = [
      ...predicted.written.map((rel) => ({
        path: toPosixRel(rel),
        sha256: sha256Hex(generatedContentByRel.get(rel)!),
      })),
      ...predicted.removed.map((rel) => ({ path: toPosixRel(rel), sha256: null })),
      ...tombstoneRels.map((rel) => worktreeStateEntry(vaultDir, rel)),
    ];
    const journalEntries: VaultWriteJournalEntry[] = [];
    {
      const seen = new Set<string>();
      for (const e of [...(priorJournal?.entries ?? []), ...ourJournalEntries]) {
        const key = `${e.path}\0${e.sha256 ?? "\0absent"}`;
        if (seen.has(key)) continue;
        seen.add(key);
        journalEntries.push(e);
      }
    }
    writeVaultWriteJournal(cacheDir, journalEntries, began);
    // 適用中に書いた partial をここに積む。writeVaultDelta が途中で throw しても
    // created が残るので、巻き戻しで untracked な新規ファイルを確実に消せる。
    const delta = { written: [] as string[], removed: [] as string[], created: [] as string[] };
    const writeDelta = args.writeDelta ?? writeVaultDelta;
    const backup = snapshotVaultPreimages(vaultDir, generatedRelPaths);
    // gitCommitVault が stage したパス (rollback で unstage する範囲)。stage 前の失敗では
    // null のまま = index には一切触らない。
    let stagedPaths: string[] | null = null;
    // 指摘A: finally の分岐用。true = commit まで到達した成功 run (residue を含め全て
    // クリアして良い)。false のまま finally に入った失敗 run は、crashResidue なら
    // 引き受けた前世代 residue を書き戻して保全する。
    let runSucceeded = false;
    try {
      // detached HEAD (assertOnBranch) は最上流 (beginVaultWrite より前) で検査済み (指摘F)。
      writeDelta(vaultDir, v.nextGraph, delta);
      // 書き込み後セルフチェック: 説明できないファイル削除 (= plan に無い知識の消滅) を
      // commit 前に検知して throw する (下の catch で HEAD へ巻き戻る)。
      assertRemovalsExplained({ currentGraph: current, nextGraph: v.nextGraph, plan: effectivePlan, removed: delta.removed });
      // node delete を tombstone 台帳へ記録 (mutation と同一コミットで確定する。
      // シャードは delta に積むので、commit 失敗時の巻き戻しは .md と同じ経路で効く)。
      const tombstones = recordTombstones({ vaultDir, plan: effectivePlan, currentGraph: current, cascadedEdges: v.cascadedEdges ?? [], delta });
      if (hasDeletes) {
        // 指摘B: tombstone 系エントリの intended を実書き後の内容で更新する (これ以降の
        // crash では追記済みシャードが内容検証を通り、次の回復で吸収される)。
        const refresh = new Set([...tombstoneRels, ...tombstones.shards].map(toPosixRel));
        const refreshed = journalEntries.filter((e) => !refresh.has(e.path));
        for (const rel of refresh) refreshed.push(worktreeStateEntry(vaultDir, rel));
        writeVaultWriteJournal(cacheDir, refreshed, began);
      }
      let head: string | null = null;
      if (args.git !== false) {
        stagedPaths = mutationStagePaths(
          vaultDir,
          // crash 痕跡 + journal がある時だけ、その内容検証済みパスを吸収する (指摘3/B)。
          crashResidue && priorJournal ? verifiedPriorPaths : [],
          delta
        );
        head = gitCommitVault(vaultDir, args.reason ?? plan.reason ?? "graphrag mutation", stagedPaths);
      }
      runSucceeded = true;
      return {
        applied: true,
        head,
        duplicate_check,
        attribute_check,
        ...(idempotent_replay ? { idempotent_replay } : {}),
        files: delta,
        changed_nodes: {
          created: effectivePlan.nodes
            .filter((n: any) => (n.op ?? "create") === "create")
            .map((n: any) => n.id),
          updated: effectivePlan.nodes.filter((n: any) => n.op === "update").map((n: any) => n.id),
          deleted: effectivePlan.nodes.filter((n: any) => n.op === "delete").map((n: any) => n.id),
        },
        cascaded_edge_ids: v.cascadedEdgeIds,
        // 削除の台帳記録 (issue #18)。recorded=0 (削除なし) なら shards は空。
        tombstones,
        // 書き込み後セルフチェックの結果 (ここに到達した = 全削除が説明済み)。
        post_write_check: {
          id: "unexplained-removal",
          status: "ok",
          removed_files: delta.removed.length,
        },
        // lock 外の suggestions 組み立てに渡す内部フィールド (出力直前に除去する)。
        __suggestionsInput: { nextGraph: v.nextGraph, plan: effectivePlan, relations: relationCandidates },
      };
    } catch (applyErr) {
      // 適用中のどの失敗(writeVaultDelta 途中失敗・commit 失敗等)でも、この mutation が
      // 触ったパスだけを開始前の状態へ巻き戻し、部分適用を残さない (issue #26: vault 全体を
      // HEAD へ restore すると利用者の未コミット変更まで消えるのでしない)。git 無効モード
      // でも backup ベースの巻き戻しはそのまま効く (index 操作だけ stagedPaths=null で skip)。
      rollbackVaultWorktree(vaultDir, delta, backup, args.git !== false ? stagedPaths : null);
      throw applyErr;
    } finally {
      if (runSucceeded || !crashResidue) {
        // journal の寿命は seq 書込窓と同じ: 窓が閉じる (成功 = commit 済み / 通常 run の
        // 失敗 = rollback 済みで torn 無し) 時に消す。hard crash ではこの finally 自体が
        // 走らないので journal は seq 奇数と一緒に残り、次の writer の回復材料になる。
        //
        // 削除順は journal → seq (3回目レビュー指摘1): 逆順 (endVaultWrite → clear) だと
        // この 2 操作間の hard crash が「偶数 seq + 完了済み writer の journal」を残し、
        // 次 writer が begin 直後 (自 journal 書込前) に crash した場合に、さらに次の
        // mutation が前世代 journal を今回の crash に属すると誤認して無関係な利用者 WIP
        // を吸収し得た。journal を先に消せば、この境界での crash は「奇数 seq + journal
        // 無し」= 既存の安全劣化 (吸収なし、fsck の git-uncommitted が人手復旧を案内) に
        // 落ちる。journal の seq 打刻突合が第二の防壁として同じ誤認を独立に塞ぐ。
        clearVaultWriteJournal(cacheDir);
        endVaultWrite(cacheDir, began);
      } else if (priorJournal) {
        // 敵対レビュー指摘A: crash residue を引き受けた回復 run の失敗は、residue を
        // 焼かない。rollback は自分の delta しか戻せず、前 writer の torn は worktree に
        // 残ったまま — ここで journal を消して seq を偶数化すると、その torn は二度と
        // 吸収されず、以後そのパスへの mutation は DIRTY_VAULT_WIP_BLOCKED で恒久
        // ブロックされる。journal を merge 前の前世代内容 (元の奇数 seq 打刻) へ書き戻し、
        // seq は奇数のまま残す (endVaultWrite を呼ばない)。crashResidue では
        // beginVaultWrite が既奇数を据え置くため began === observedSeq === priorJournal.seq
        // であり、次の writer は同じ奇数 seq を観測してこの journal を正しく認める。
        // lock 解放後の「奇数 seq + lock 不在」は読み手側が crash residue の静的状態と
        // して読む (vault-lock writerCrashed 参照)。
        writeVaultWriteJournal(cacheDir, priorJournal.entries, priorJournal.seq);
      } else {
        // crash residue はあるが有効な前世代 journal は無かった (journal 無し劣化)。
        // 自分の journal だけ消し、奇数 seq (crash 痕跡) は残す — fsck の git-uncommitted
        // が引き続き人手復旧を案内する。
        clearVaultWriteJournal(cacheDir);
      }
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
  // plan 全体が冪等リプレイ (= vault 無変更) なら索引再構築も suggestions も不要。
  if ((result as any).__replayOnly) {
    const { __replayOnly, ...replayResult } = result as any;
    return replayResult;
  }

  let index_status: any;
  try {
    await buildIndex({ vault: vaultDir, out: defaultVectorIndexPath(vaultDir) });
    index_status = { ok: true };
  } catch (e: any) {
    index_status = {
      ok: false,
      error: String(e?.message ?? e),
      // リトライ連打の根 (issue #24): 索引失敗を書き込み失敗と誤読して add を再送させない。
      note:
        "the mutation IS already committed — do NOT retry the add/commit-mutation for this; " +
        "the vector index is a secondary artifact and will be rebuilt automatically on the next ask/mutation",
    }; // NON-FATAL
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
    let suggestIndexCorrupt: string | null = null;
    try {
      suggestIndex = await (sd.loadIndex
        ? sd.loadIndex()
        : loadVectorIndex(vaultVectorIndexReadPath(vaultDir)));
    } catch (e: any) {
      suggestIndex = null; // 不在扱いで skip (NON-FATAL) — ただし下で note を残す
      suggestIndexCorrupt = String(e?.message ?? e);
    }
    // embed: index の document 空間準拠の埋め込み (索引行と同じ側の接頭辞。
    // suggest-policy-edges の契約 = embedForIndex(index, text, "document") 相当)。
    // index 不在なら null (binding は skip 理由を返す)。
    const embed = sd.embed
      ? sd.embed
      : suggestIndex
        ? (text: string) => embedForIndex(suggestIndex, text, "document")
        : null;
    // issue #31: バッチ口。DI が embedMany を指定すればそれを、単発 embed のみの DI は
    // null (suggestBindingsForNodes 側の直列 fallback)、DI 無しは既定のバッチ経路。
    const embedMany = sd.embedMany
      ? sd.embedMany
      : sd.embed
        ? null
        : suggestIndex
          ? (texts: string[]) => embedManyForIndex(suggestIndex, texts, "document")
          : null;
    suggestions = await buildSuggestions({
      nextGraph: __suggestionsInput.nextGraph,
      plan: __suggestionsInput.plan,
      relations: __suggestionsInput.relations,
      vectorIndex: suggestIndex,
      embed,
      embedMany,
      recentHitIds,
      schema: args.schema,
    });
    if (suggestIndexCorrupt) {
      // 破損索引で index 無しに縮退したことを無音にしない (advisory only)。
      suggestions = {
        ...suggestions,
        index_corrupt: true,
        index_corrupt_reason: `vector index unreadable — suggestions built without it: ${suggestIndexCorrupt}`,
      };
    }
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
