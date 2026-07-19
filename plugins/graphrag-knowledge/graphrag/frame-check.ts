/**
 * frame-check: 新規/変更ファイルの「配置」を横断構造の地図と突き合わせる read-only 検査。
 *
 * 裁くのではなく地図を見せる (crosscut-map.ts 冒頭の設計思想)。「どこにも属さない = 悪」とは
 * しない — 小さいクラスタは Component を彫らないのが carving の思想なので、無所属は正当。
 * 所見 (findings) にするのは誤報率の低い2ケースだけ:
 *
 *   - in-footprint-unwired : ちょうど1つの Component の縄張り (メンバー File のディレクトリ) の
 *                            内側に作られたのに evidenced_by が無い。その Component の一員か、
 *                            置き場所間違いかのどちらか = 言ってよい。plan_fragment 同梱。
 *                            フラット配置で縄張りが重なる場合は発火しない (誤発砲より沈黙)。
 *   - component-candidate  : 同じディレクトリに未登記の実装ファイルが閾値以上溜まった。
 *                            「悪」ではなく「Component が生まれたがっている」合図 —
 *                            枠は禁止で守るのではなく、実在が閾値を超えた時に登記を促されて育つ。
 *
 * それ以外は entries (per-file の地図: status + claimants) として記述的に返すだけ。
 * carving-check #3/#4 (全実装ファイルの Component/Layer 所属) と同じ規範を、索引 (carve) を
 * 待たずに任意のファイルリストへ即時適用する切り出し。免除語彙も同じもの
 * (BUILTIN_ORPHAN_PATTERNS + .graphrag/carving.json) を使う。
 *
 * 入力: --files <p,...> (繰り返し可) / --diff <base...head> / 省略時は working tree
 * (git diff --name-only HEAD + untracked)。exit は常に 0 (--strict 時のみ warn で 1)。
 *
 * Usage:
 *   node --experimental-strip-types graphrag/cli.ts frame-check [--files <p,...>] [--diff <range>]
 *     [--root <repo>] [--vault <dir>] [--threshold-files N] [--strict]
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { importVault } from "./import-vault.ts";
import { buildCrosscutIndex, claimantsForPath, isImplPath, type CrosscutIndex } from "./crosscut-map.ts";
import { BUILTIN_ORPHAN_PATTERNS } from "./check-carving.ts";
import { loadCarvingConfig } from "./carving-config.ts";
import { edgeId } from "./cli-typed-add.ts";

export type FrameStatus =
  | "registered"      // File ノードが在り、横断構造に所属
  | "known-unframed"  // File ノードは在るが無所属 (carve 時の carving-check の守備範囲)
  | "exempt"          // builtin orphan パターン / carving.json 免除に該当
  | "non-impl"        // 実装ファイルでない (配置判定の対象外)
  | "unwired"         // 未登記かつ一意 claimant の縄張り内 → finding
  | "unclaimed";      // 未登記で claimant 無し/複数 (無所属は正当 — 情報のみ)

export interface FrameEntry {
  path: string;
  status: FrameStatus;
  /** そのディレクトリを縄張りに持つ Component (dir 内メンバー数降順)。地図として常に出す。 */
  claimants: { id: string; title: string; dir_members: number }[];
  exempt_reason?: string;
}

export interface FrameFinding {
  kind: "in-footprint-unwired" | "component-candidate";
  severity: "warn";
  file_path?: string;
  dir?: string;
  detail: string;
  next_step: string;
  plan_fragment?: unknown;
}

export interface FrameCheckResult {
  generated_by: "graphrag/frame-check.ts";
  vault_dir: string;
  root: string;
  input_source: "files" | "diff" | "worktree";
  threshold_files: number;
  status: "ok" | "warn";
  entries: FrameEntry[];
  findings: FrameFinding[];
  counts: { inputs: number; registered: number; unwired: number; unclaimed: number; exempt: number; non_impl: number; warnings: number };
  note: string;
}

export interface FrameCheckDeps {
  /** working tree の変更ファイル列挙 (tracked 変更 + untracked)。テスト DI 用。 */
  gitWorktreePaths?: (root: string) => string[];
  /** git diff --name-only <range>。テスト DI 用。 */
  gitDiffPaths?: (root: string, range: string) => string[];
  /** dir 直下 (再帰しない) の tracked ファイル列挙。cluster 判定用。テスト DI 用。 */
  gitLsDir?: (root: string, dir: string) => string[];
}

function gitLines(root: string, args: string[]): string[] {
  const out = execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\n").filter((l) => l.length > 0);
}

// delta-check と共有する変更ファイル列挙 (入力契約 files > diff > worktree も共有)。
export function defaultGitWorktreePaths(root: string): string[] {
  return [
    ...gitLines(root, ["diff", "--name-only", "HEAD"]),
    ...gitLines(root, ["ls-files", "--others", "--exclude-standard"])
  ];
}

export function defaultGitDiffPaths(root: string, range: string): string[] {
  return gitLines(root, ["diff", "--name-only", range]);
}

function defaultGitLsDir(root: string, dir: string): string[] {
  // dir 直下のみ (サブディレクトリは別クラスタ)。dir="." はルート直下。
  const spec = dir === "." ? "*" : `${dir}/*`;
  return gitLines(root, ["ls-files", "--", spec]).filter((p) => posixDirname(p) === dir);
}

function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "." : p.slice(0, i);
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** 免除判定: builtin パターン (どのプロジェクトでも構造的に無所属) + carving.json の literal path。 */
function exemptionFor(relPath: string, configPaths: Map<string, string>): string | null {
  const withSlash = relPath.startsWith("/") ? relPath : `/${relPath}`;
  for (const { name, pattern } of BUILTIN_ORPHAN_PATTERNS) {
    if (pattern.test(withSlash) || pattern.test(relPath)) return `builtin:${name}`;
  }
  const reason = configPaths.get(relPath);
  return reason !== undefined ? `carving.json: ${reason}` : null;
}

const DEFAULT_CLUSTER_THRESHOLD = 5;

export function frameCheck(
  options: {
    vaultDir: string;
    root: string;
    paths: string[];
    inputSource: "files" | "diff" | "worktree";
    thresholdFiles?: number;
  },
  deps: FrameCheckDeps = {}
): FrameCheckResult {
  const threshold = options.thresholdFiles ?? DEFAULT_CLUSTER_THRESHOLD;
  const gitLsDir = deps.gitLsDir ?? defaultGitLsDir;
  const graph = importVault(options.vaultDir);
  const index: CrosscutIndex = buildCrosscutIndex(graph);

  const configLoad = loadCarvingConfig(path.join(options.root, ".graphrag", "carving.json"));
  const configPaths = new Map<string, string>();
  for (const o of configLoad.config?.allowed_orphans ?? []) configPaths.set(o.path, o.reason ?? "(no reason)");

  const entries: FrameEntry[] = [];
  const findings: FrameFinding[] = [];
  const dirsToInspect = new Set<string>();

  const isRegistered = (relPath: string): "registered" | "known-unframed" | null => {
    const fid = index.fileIdByPath.get(relPath);
    if (!fid) return null;
    return (index.membershipByFileId.get(fid) ?? []).length > 0 ? "registered" : "known-unframed";
  };

  for (const raw of [...new Set(options.paths)]) {
    const relPath = toPosix(raw).replace(/^\.\//, "");
    const claim = claimantsForPath(index, relPath);
    const claimants = claim.candidates.map((c) => ({ id: c.ref.id, title: c.ref.title, dir_members: c.dir_members }));

    if (!isImplPath(relPath)) {
      entries.push({ path: relPath, status: "non-impl", claimants });
      continue;
    }
    const exemption = exemptionFor(relPath, configPaths);
    if (exemption) {
      entries.push({ path: relPath, status: "exempt", claimants, exempt_reason: exemption });
      continue;
    }
    const known = isRegistered(relPath);
    if (known) {
      entries.push({ path: relPath, status: known, claimants });
      if (known === "known-unframed") dirsToInspect.add(posixDirname(relPath));
      continue;
    }

    // 未登記の実装ファイル
    dirsToInspect.add(posixDirname(relPath));
    if (claim.unique) {
      entries.push({ path: relPath, status: "unwired", claimants });
      const comp = claim.unique;
      const sys = comp.id.split(":")[1] ?? "<system>";
      const fileId = `file:${sys}:${relPath}`;
      findings.push({
        kind: "in-footprint-unwired",
        severity: "warn",
        file_path: relPath,
        detail:
          `${relPath} sits inside the home directory of ${comp.id} ("${comp.title}") but is not wired to it. ` +
          "Either it is a member of that component, or it is in the wrong place — both are worth a conscious decision.",
        next_step:
          `If it belongs to "${comp.title}": apply the plan_fragment below via commit-mutation. ` +
          "If it belongs elsewhere: move the file to its concept's home. " +
          "If it is genuinely frameless: fine — record it in .graphrag/carving.json via carving-allow with a reason.",
        plan_fragment: {
          reason: `wire ${relPath} into ${comp.id} (frame-check in-footprint-unwired)`,
          nodes: index.fileIdByPath.has(relPath)
            ? []
            : [{ op: "create", id: fileId, type: "File", path: relPath, title: relPath.slice(relPath.lastIndexOf("/") + 1) }],
          edges: [
            { op: "create", id: edgeId(comp.id, "evidenced_by", fileId), type: "evidenced_by", from: comp.id, to: fileId }
          ]
        }
      });
    } else {
      entries.push({ path: relPath, status: "unclaimed", claimants });
    }
  }

  // component-candidate: 触れたディレクトリの未登記実装ファイルの実数を git で数える
  // (入力リストだけだと蓄積が見えない)。閾値以上 = Component が生まれたがっている合図。
  for (const dir of [...dirsToInspect].sort()) {
    let dirFiles: string[];
    try {
      dirFiles = gitLsDir(options.root, dir);
    } catch {
      continue; // git 不能環境では cluster 判定を静かに諦める (entries は既に出ている)
    }
    const unregistered = dirFiles.filter(
      (p) => isImplPath(p) && !exemptionFor(p, configPaths) && isRegistered(p) !== "registered"
    );
    if (unregistered.length >= threshold) {
      findings.push({
        kind: "component-candidate",
        severity: "warn",
        dir,
        detail:
          `${dir}/ now holds ${unregistered.length} unregistered implementation files (threshold: ${threshold}). ` +
          "This is not a violation — it is the signal that a Component may want to be born here " +
          "(frames are carved when substance crosses a threshold, not before).",
        next_step:
          "Decide the concept: if these files form a cohesive unit, register a Component (+ evidenced_by to its members) " +
          "via commit-mutation — templates: references/mutation-templates.md. If they are structurally frameless " +
          `(composition roots, scratch), exempt them with reasons via carving-allow. Sample: ${unregistered.slice(0, 5).join(", ")}`
      });
    }
  }

  const warnings = findings.length;
  const count = (s: FrameStatus) => entries.filter((e) => e.status === s).length;
  return {
    generated_by: "graphrag/frame-check.ts",
    vault_dir: options.vaultDir,
    root: options.root,
    input_source: options.inputSource,
    threshold_files: threshold,
    status: warnings > 0 ? "warn" : "ok",
    entries,
    findings,
    counts: {
      inputs: entries.length,
      registered: count("registered"),
      unwired: count("unwired"),
      unclaimed: count("unclaimed") + count("known-unframed"),
      exempt: count("exempt"),
      non_impl: count("non-impl"),
      warnings
    },
    note:
      "Read-only placement map. 'unclaimed' is NOT a verdict — small clusters legitimately have no Component " +
      "(carving philosophy). Findings are limited to the two high-precision cases: a file inside exactly one " +
      "component's home that is not wired to it, and a directory whose unregistered pile crossed the threshold. " +
      "Footprints are directory-based: in flat layouts claimants overlap and the unwired finding stays silent by design."
  };
}

function parseArgs(argv: string[]) {
  const p: Record<string, any> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith("--")) {
      if (p[k] === undefined) p[k] = v;
      else p[k] = Array.isArray(p[k]) ? [...p[k], v] : [p[k], v];
      i += 1;
    } else p[k] = true;
  }
  const files = p.files === undefined
    ? undefined
    : (Array.isArray(p.files) ? p.files : [p.files]).flatMap((s: string) => s.split(",")).map((s: string) => s.trim()).filter(Boolean);
  const threshold = Number(p["threshold-files"]);
  return {
    vault: typeof p.vault === "string" ? p.vault : process.env.GRAPHRAG_VAULT_DIR,
    root: typeof p.root === "string" ? p.root : process.cwd(),
    files,
    diff: typeof p.diff === "string" ? p.diff : undefined,
    thresholdFiles: Number.isFinite(threshold) && threshold > 0 ? threshold : undefined,
    strict: p.strict === true
  };
}

export function runFrameCheck(
  argv: string[] = process.argv.slice(2),
  deps: FrameCheckDeps = {}
): FrameCheckResult {
  const args = parseArgs(argv);
  if (!args.vault) {
    throw new Error("frame-check requires a vault: pass --vault <dir> or set GRAPHRAG_VAULT_DIR");
  }
  let paths: string[];
  let inputSource: "files" | "diff" | "worktree";
  if (args.files && args.files.length > 0) {
    paths = args.files;
    inputSource = "files";
  } else if (args.diff) {
    paths = (deps.gitDiffPaths ?? defaultGitDiffPaths)(args.root, args.diff);
    inputSource = "diff";
  } else {
    paths = (deps.gitWorktreePaths ?? defaultGitWorktreePaths)(args.root);
    inputSource = "worktree";
  }
  const result = frameCheck(
    { vaultDir: args.vault, root: args.root, paths, inputSource, thresholdFiles: args.thresholdFiles },
    deps
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = args.strict && result.status === "warn" ? 1 : 0;
  return result;
}

function isMainModule(url: string): boolean {
  if (!process.argv[1]) return false;
  const entryUrl = pathToFileURL(process.argv[1]).href;
  return entryUrl === url || entryUrl.replace(/\.mjs$/, ".ts") === url;
}
if (isMainModule(import.meta.url)) {
  runFrameCheck();
}
