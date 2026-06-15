// 知識ノードの陳腐化候補の機械抽出 (読み取り専用・意味判断なし)
//
// 目的: Decision/Constraint/Risk/OperationalKnowledge は書かれた時点のコードを
// 前提にしている。その後コードだけが進むと「グラフが正本のつもりで古い」状態に
// 黙って落ちる。本コマンドはノードの documented_by/sets_policy_for/constrains が
// 指す File について、ノードの generated_at 以降にその path を触ったコミット数を
// 数え、閾値以上を candidate として列挙するだけ。
// 「本当に陳腐化したか」の意味判断は人間起動の audit に委ねる (機械は提示のみ)。
//
// git 呼び出しは関数注入 — テストは合成データで決定論的に。
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { importVault } from "./import-vault.ts";
import { canonicalType } from "./schema.ts";

export interface StalenessDeps {
  /** generated_at (since) 以降に path を触ったコミット (新しい順) */
  gitLogSince?: (root: string, since: string, filePath: string) => { hash: string; subject: string }[];
}

export interface StalenessCandidate {
  node_id: string;
  node_title: string;
  file_path: string;
  commits_since: number;
  last_commit_subject: string;
}

export interface StalenessResult {
  generated_by: "graphrag/staleness-check.ts";
  vault_dir: string;
  root: string;
  threshold_commits: number;
  pairs_checked: number;
  skipped_no_generated_at: number;
  candidate_count: number;
  candidates: StalenessCandidate[];
  note: string;
}

// 知識ノードのうち「コードを前提に書かれる」4 型のみ対象 (Investigation 等は対象外)
const STALENESS_NODE_TYPES = new Set(["Decision", "Constraint", "Risk", "OperationalKnowledge"]);
// File を宛先に取りうる evidence/効力エッジのみ辿る
const STALENESS_EDGE_TYPES = new Set(["documented_by", "sets_policy_for", "constrains"]);

function defaultGitLogSince(
  root: string,
  since: string,
  filePath: string
): { hash: string; subject: string }[] {
  const out = execFileSync(
    "git",
    ["-C", root, "log", `--since=${since}`, "--pretty=format:%H%x1f%s", "--", filePath],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  return out
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [hash, subject] = line.split("\x1f");
      return { hash, subject: subject ?? "" };
    });
}

export function stalenessCheck(
  options: { vaultDir: string; root: string; thresholdCommits?: number },
  deps: StalenessDeps = {}
): StalenessResult {
  const threshold = options.thresholdCommits ?? 5;
  const gitLogSince = deps.gitLogSince ?? defaultGitLogSince;
  const graph = importVault(options.vaultDir);

  const nodesById = new Map<string, Record<string, unknown>>();
  for (const n of graph.nodes) {
    if (typeof n.id === "string") nodesById.set(n.id, n);
  }

  const candidates: StalenessCandidate[] = [];
  let pairsChecked = 0;
  let skippedNoGeneratedAt = 0;
  const seenPairs = new Set<string>(); // 同じ (node, path) を複数エッジで重複チェックしない

  for (const e of graph.edges) {
    if (typeof e.type !== "string" || !STALENESS_EDGE_TYPES.has(e.type)) continue;
    const fromNode = typeof e.from === "string" ? nodesById.get(e.from) : undefined;
    const toNode = typeof e.to === "string" ? nodesById.get(e.to) : undefined;
    if (!fromNode || !toNode) continue;
    if (!STALENESS_NODE_TYPES.has(canonicalType(fromNode.type as string) ?? "")) continue;
    if (canonicalType(toNode.type as string) !== "File" || typeof toNode.path !== "string") continue;

    const pairKey = `${fromNode.id}\u0000${toNode.path}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    const generatedAt = fromNode.generated_at;
    if (typeof generatedAt !== "string" || generatedAt.length === 0) {
      skippedNoGeneratedAt += 1; // 基準時刻が無いと測れない — 黙って落とさず件数で可視化
      continue;
    }
    pairsChecked += 1;
    const commits = gitLogSince(options.root, generatedAt, toNode.path);
    if (commits.length < threshold) continue;
    candidates.push({
      node_id: String(fromNode.id),
      node_title: String(fromNode.title ?? fromNode.id),
      file_path: toNode.path,
      commits_since: commits.length,
      last_commit_subject: commits[0]?.subject ?? ""
    });
  }

  candidates.sort((a, b) => b.commits_since - a.commits_since);

  return {
    generated_by: "graphrag/staleness-check.ts",
    vault_dir: options.vaultDir,
    root: options.root,
    threshold_commits: threshold,
    pairs_checked: pairsChecked,
    skipped_no_generated_at: skippedNoGeneratedAt,
    candidate_count: candidates.length,
    candidates,
    note:
      "読み取り専用の機械抽出。コミットが積まれた=陳腐化ではない — " +
      "本当に前提が崩れたかの意味判断は人間起動の audit に委ねる。"
  };
}

function parseArgs(argv: string[]) {
  const p: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith("--")) { p[k] = v; i += 1; } else p[k] = true;
  }
  const threshold = Number(p["threshold-commits"]);
  return {
    root: typeof p.root === "string" ? p.root : process.cwd(),
    vault: typeof p.vault === "string" ? p.vault : process.env.GRAPHRAG_VAULT_DIR,
    thresholdCommits: Number.isFinite(threshold) && threshold > 0 ? threshold : 5
  };
}

export function runStalenessCheck(
  argv: string[] = process.argv.slice(2),
  deps: StalenessDeps = {}
): StalenessResult {
  const args = parseArgs(argv);
  if (!args.vault) {
    throw new Error("staleness-check requires a vault: pass --vault <dir> or set GRAPHRAG_VAULT_DIR");
  }
  const result = stalenessCheck(
    { vaultDir: args.vault, root: args.root, thresholdCommits: args.thresholdCommits },
    deps
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function isMainModule(url: string): boolean {
  if (!process.argv[1]) return false;
  const entryUrl = pathToFileURL(process.argv[1]).href;
  return entryUrl === url || entryUrl.replace(/\.mjs$/, ".ts") === url;
}
if (isMainModule(import.meta.url)) {
  runStalenessCheck();
}
