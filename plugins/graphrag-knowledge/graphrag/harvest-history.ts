// 履歴からの知識候補の決定論抽出 (書き込みなし)
//
// 目的: 「却下されたアプローチ」「運用ハマり」は git 履歴とコード中のマーカーに
// 既に痕跡が残っているのに、グラフには書かれていないことが多い。本コマンドは
//   (1) revert コミット → RejectedOption candidate
//   (2) HACK|FIXME|WORKAROUND|XXX マーカー → OperationalKnowledge/Risk candidate
// を機械的に列挙するだけ。candidate を本当にノード化するかは LLM が履歴・コードを
// 見て判断し typed-add する (concern-suggest と同じ思想: 機械は提示、確定は LLM)。
//
// git 呼び出し (log / ls-files) と file 読みは関数注入 — テストは合成データで決定論的に。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export interface GitCommit {
  hash: string;
  subject: string;
  date: string; // YYYY-MM-DD
  body: string;
}

export interface HarvestDeps {
  gitLog?: (root: string) => GitCommit[];
  gitLsFiles?: (root: string) => string[];
  readFile?: (absPath: string) => string | null; // 読めない/バイナリは null
}

export interface RevertCandidate {
  suggested_slug: string;
  title: string;
  commits: { hash: string; subject: string; date: string }[];
  note: string;
}

export interface MarkerCandidate {
  path: string;
  line: number;
  marker: string;
  text: string;
}

export interface HarvestResult {
  generated_by: "graphrag/harvest-history.ts";
  root: string;
  system: string | null;
  revert_candidates: {
    suggested_type: "RejectedOption";
    count: number;
    candidates: RevertCandidate[];
  };
  marker_candidates: {
    suggested_type: "OperationalKnowledge | Risk";
    count: number;
    candidates: MarkerCandidate[];
  };
  note: string;
}

// --- git 既定実装 (注入されなければこれを使う) ---------------------------------

// %x1f (unit separator) / %x1e (record separator) はコミットメッセージに現れない前提の区切り
function defaultGitLog(root: string): GitCommit[] {
  const out = execFileSync(
    "git",
    ["-C", root, "log", "--date=short", "--pretty=format:%H%x1f%ad%x1f%s%x1f%b%x1e"],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
  );
  const commits: GitCommit[] = [];
  for (const rec of out.split("\x1e")) {
    const trimmed = rec.replace(/^\s+/, "");
    if (!trimmed) continue;
    const [hash, date, subject, body] = trimmed.split("\x1f");
    if (!hash) continue;
    commits.push({ hash, date: date ?? "", subject: subject ?? "", body: body ?? "" });
  }
  return commits;
}

function defaultGitLsFiles(root: string): string[] {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  return out.split("\0").filter((p) => p.length > 0);
}

function defaultReadFile(absPath: string): string | null {
  try {
    const content = fs.readFileSync(absPath, "utf8");
    if (content.includes("\0")) return null; // バイナリは走査対象外
    return content;
  } catch {
    return null;
  }
}

// --- (1) revert コミット → RejectedOption candidate -----------------------------

export function isRevertCommit(c: GitCommit): boolean {
  return /^Revert\b/.test(c.subject) || c.body.includes("This reverts commit");
}

/** Revert "..." の入れ子を剥がして元コミット subject を取り出す (Revert の Revert も同じ束に) */
export function revertedSubject(subject: string): string {
  let s = subject;
  let m: RegExpExecArray | null;
  while ((m = /^Revert\s+"([\s\S]+)"\s*$/.exec(s))) s = m[1];
  return s;
}

// id 規約 `<typeSlug>:<system>:<slug>` の slug 部の提案値。ascii 英数とハイフンに
// 丸める (日本語 subject は落ちて空になりうる → fallback は revert ハッシュ由来)
export function suggestSlug(subject: string, fallback: string): string {
  const slug = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || fallback;
}

export function extractRevertCandidates(commits: GitCommit[]): RevertCandidate[] {
  // 同じ元 subject への revert は一つの candidate に束ねる (試して戻すを繰り返した跡)
  const groups = new Map<string, { hash: string; subject: string; date: string }[]>();
  for (const c of commits) {
    if (!isRevertCommit(c)) continue;
    const key = revertedSubject(c.subject);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ hash: c.hash, subject: c.subject, date: c.date });
  }
  return [...groups.entries()].map(([original, list]) => ({
    suggested_slug: suggestSlug(original, `reverted-${list[0].hash.slice(0, 8)}`),
    title: `差し戻された変更: ${original}`,
    commits: list,
    note:
      "revert コミット由来の候補。差し戻された変更が「却下されたアプローチ」なのか" +
      "単なる手戻り (再適用済み等) なのかは、履歴と diff を見て判断してからノード化する。"
  }));
}

// --- (2) コメントマーカー → OperationalKnowledge/Risk candidate ------------------

export const HARVEST_MARKERS = ["HACK", "FIXME", "WORKAROUND", "XXX"] as const;
const MARKER_RE = new RegExp(`\\b(${HARVEST_MARKERS.join("|")})\\b`);

export function extractMarkerCandidates(
  root: string,
  files: string[],
  readFile: (absPath: string) => string | null
): MarkerCandidate[] {
  const candidates: MarkerCandidate[] = [];
  for (const rel of files) {
    const content = readFile(path.join(root, rel));
    if (content === null) continue;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const m = MARKER_RE.exec(lines[i]);
      if (!m) continue;
      candidates.push({
        path: rel,
        line: i + 1, // 1 始まり (エディタ表記に合わせる)
        marker: m[1],
        text: lines[i].trim().slice(0, 200)
      });
    }
  }
  return candidates;
}

// --- 本体 -----------------------------------------------------------------------

export function harvestHistory(
  options: { root: string; system?: string | null },
  deps: HarvestDeps = {}
): HarvestResult {
  const gitLog = deps.gitLog ?? defaultGitLog;
  const gitLsFiles = deps.gitLsFiles ?? defaultGitLsFiles;
  const readFile = deps.readFile ?? defaultReadFile;

  const reverts = extractRevertCandidates(gitLog(options.root));
  const markers = extractMarkerCandidates(options.root, gitLsFiles(options.root), readFile);

  return {
    generated_by: "graphrag/harvest-history.ts",
    root: options.root,
    system: options.system ?? null,
    revert_candidates: {
      suggested_type: "RejectedOption",
      count: reverts.length,
      candidates: reverts
    },
    marker_candidates: {
      suggested_type: "OperationalKnowledge | Risk",
      count: markers.length,
      candidates: markers
    },
    note:
      "決定論抽出のみ・書き込みなし。candidate をノード化するかは LLM が判断して typed-add する " +
      "(重複確認を先に)。"
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
  return {
    root: typeof p.root === "string" ? p.root : undefined,
    system: typeof p.system === "string" ? p.system : null,
    out: typeof p.out === "string" ? p.out : undefined
  };
}

export function runHarvestHistory(
  argv: string[] = process.argv.slice(2),
  deps: HarvestDeps = {}
): HarvestResult {
  const args = parseArgs(argv);
  if (!args.root) {
    throw new Error("harvest-history requires --root <repo> (the git repository to harvest from)");
  }
  const result = harvestHistory({ root: args.root, system: args.system }, deps);
  if (args.out) {
    fs.writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
    console.error(`Wrote ${args.out}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function isMainModule(url: string): boolean {
  if (!process.argv[1]) return false;
  const entryUrl = pathToFileURL(process.argv[1]).href;
  return entryUrl === url || entryUrl.replace(/\.mjs$/, ".ts") === url;
}
if (isMainModule(import.meta.url)) {
  runHarvestHistory();
}
