/**
 * lane-log: commit 導線 (delta-check worktree lane) の機械観測ログ 2 系統。
 * どちらも cache 配下の jsonl (vault には書かない — 再生成可能な機械ローカル状態)。
 * rail-log.jsonl (rail-common) と同じ流儀: 追記・自動ローテーション・失敗は無音。
 *
 *   - echo-log.jsonl      (issue #22): authority echo の発火履歴。偽陽性率の高い指紋の
 *                         棚卸し (stocktake の echo_stats) に使う。これが無いと
 *                         「どの alias が狼少年か」を裁く材料が存在しない。
 *   - evidence-stale.jsonl (issue #21): 「knowledge ノードの evidence に配線された
 *                         ファイルが commit で変更された」の台帳 ({ts, path})。
 *                         ask 配達時に node.generated_at (最終検証時点) と突合し、
 *                         検証後に正本側だけが動いたノードへ ⚠ を添える。
 *                         検知 (ほぼ無料) と再抽出 (lazy・人間/LLM の判断) を分離する。
 *
 * 記録は worktree lane (commit hook / pre-commit / 既定 CLI 実行) のみ。--diff / --files
 * での過去レンジのレビュー実行は「いまファイルが変わった」ではないので記録しない。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { KNOWLEDGE_TO_FILE_EDGES } from "./crosscut-map.ts";

const LOG_ROTATE_BYTES = 2 * 1024 * 1024;

export const ECHO_LOG_FILE = "echo-log.jsonl";
export const EVIDENCE_STALE_FILE = "evidence-stale.jsonl";

/** 1行1 JSON 追記。サイズ超過で .1 へローテーション。失敗は無音 (導線を落とさない)。 */
export function appendJsonlLog(cacheDir: string, filename: string, entries: Record<string, unknown>[], now: number = Date.now()): void {
  if (entries.length === 0) return;
  const fp = path.join(cacheDir, filename);
  // ローテーションと追記の try は分離する: rename が恒常的に失敗する環境 (置換不能な
  // .1、ディレクトリ権限) で追記まで永久に死ぬと、測定ログが「それらしく見えるまま
  // 更新停止」する — 無制限成長の方がデータ喪失より軽い。
  try {
    if (existsSync(fp) && statSync(fp).size > LOG_ROTATE_BYTES) {
      renameSync(fp, `${fp}.1`);
    }
  } catch {
    // ローテーション失敗でも追記は続行
  }
  try {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    const ts = new Date(now).toISOString();
    appendFileSync(fp, entries.map((e) => JSON.stringify({ ts, ...e })).join("\n") + "\n");
  } catch {
    // 観測ログの失敗は本体動作に影響させない
  }
}

/** fp.1 → fp の順で読む (ローテーション跨ぎ)。壊れた行は捨てる。 */
export function readJsonlLog(cacheDir: string, filename: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const name of [`${filename}.1`, filename]) {
    const fp = path.join(cacheDir, name);
    try {
      if (!existsSync(fp)) continue;
      for (const line of readFileSync(fp, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object") out.push(parsed);
        } catch {
          /* 壊れた行は捨てる */
        }
      }
    } catch {
      /* 読めないログは無い扱い */
    }
  }
  return out;
}

// ── echo 発火履歴 (issue #22) ────────────────────────────────────────────────

export function recordEchoFirings(
  cacheDir: string,
  echoes: { alias: string; knowledge_id: string; occurrences: { path: string }[]; occurrences_overflow?: number }[],
  now: number = Date.now()
): void {
  appendJsonlLog(
    cacheDir,
    ECHO_LOG_FILE,
    echoes.map((e) => ({
      alias: e.alias,
      knowledge_id: e.knowledge_id,
      occurrences: e.occurrences.length + (e.occurrences_overflow ?? 0),
      paths: [...new Set(e.occurrences.map((o) => o.path))].slice(0, 3)
    })),
    now
  );
}

export interface EchoStat {
  alias: string;
  knowledge_id: string;
  firings: number;
  last_fired: string | null;
}

/** alias ごとの発火集計 (発火回数降順)。stocktake の指紋棚卸し材料。 */
export function summarizeEchoLog(cacheDir: string, cap = 20): EchoStat[] {
  const byAlias = new Map<string, EchoStat>();
  for (const entry of readJsonlLog(cacheDir, ECHO_LOG_FILE)) {
    const alias = typeof entry.alias === "string" ? entry.alias : null;
    if (!alias) continue;
    const key = `${alias}\u0000${String(entry.knowledge_id ?? "")}`;
    const cur = byAlias.get(key) ?? {
      alias,
      knowledge_id: String(entry.knowledge_id ?? ""),
      firings: 0,
      last_fired: null
    };
    cur.firings += 1;
    const ts = typeof entry.ts === "string" ? entry.ts : null;
    if (ts && (!cur.last_fired || ts > cur.last_fired)) cur.last_fired = ts;
    byAlias.set(key, cur);
  }
  return [...byAlias.values()]
    .sort((a, b) => b.firings - a.firings || a.alias.localeCompare(b.alias))
    .slice(0, cap);
}

// ── evidence 鮮度台帳 (issue #21) ────────────────────────────────────────────

export function recordEvidenceChanges(cacheDir: string, paths: string[], now: number = Date.now()): void {
  appendJsonlLog(cacheDir, EVIDENCE_STALE_FILE, [...new Set(paths)].map((p) => ({ path: p })), now);
}

/** path → 最終変更観測時刻 (ISO)。 */
export function readEvidenceChangesByPath(cacheDir: string): Map<string, string> {
  const byPath = new Map<string, string>();
  for (const entry of readJsonlLog(cacheDir, EVIDENCE_STALE_FILE)) {
    const p = typeof entry.path === "string" ? entry.path : null;
    const ts = typeof entry.ts === "string" ? entry.ts : null;
    if (!p || !ts) continue;
    const cur = byPath.get(p);
    if (!cur || ts > cur) byPath.set(p, ts);
  }
  return byPath;
}

export interface EvidenceStaleNote {
  paths: { path: string; changed_at: string }[];
  verified_at: string;
  note: string;
}

// 猶予窓 (レビュー指摘): 通常フロー「knowledge を書き戻し (generated_at=T1) → 直後に
// code を commit (台帳 T2>T1)」では、T2 の変更はまさにそのノードが記述した変更であり
// stale ではない。同一セッション規模の時間差 (既定 2h、GRAPHRAG_EVIDENCE_STALE_GRACE_HOURS
// で調整可) は注記しない。偽 ⚠ の常態化は「注記は無視してよい」を学習させ導線ごと殺す。
export const EVIDENCE_STALE_GRACE_MS_DEFAULT = 2 * 60 * 60 * 1000;

/**
 * 台帳の「変更」の git 裏取り (レビュー指摘の revert/未コミット偽陽性対策)。
 * true = 記録された変更は現実に残っていない (worktree はクリーンで、最終 commit も
 * 検証時点以前) — 注記を落としてよい。git 不能・履歴不明は false (fail-open で注記を残す)。
 */
export function refuteEvidenceChangeViaGit(root: string, filePath: string, verifiedAt: string): boolean {
  try {
    const opts = { encoding: "utf8" as const, stdio: ["pipe", "pipe", "pipe"] as const };
    const dirty = execFileSync("git", ["-C", root, "status", "--porcelain", "--", filePath], opts).trim();
    if (dirty.length > 0) return false; // 変更が現に worktree に生きている
    const last = execFileSync("git", ["-C", root, "log", "-1", "--format=%cI", "--", filePath], opts).trim();
    if (!last) return false; // 履歴が取れない — 裏取り不能は注記を残す側に倒す
    const lastMs = Date.parse(last);
    const verifiedMs = Date.parse(verifiedAt);
    if (!Number.isFinite(lastMs) || !Number.isFinite(verifiedMs)) return false;
    return lastMs <= verifiedMs; // 検証以後の commit が無い = 台帳の変更は commit に至らず消えた
  } catch {
    return false;
  }
}

/**
 * 配達対象ノードの stale 判定 (決定的・意味判断なし): このノードの evidence に配線された
 * ファイルのうち、ノードの generated_at (最終検証時点) より猶予窓を超えて後に変更が
 * 観測されたものを返す。無ければ null。ノード側を update すれば generated_at が進み、
 * 注記は自然に消える。
 */
export function evidenceStaleNoteForNode(
  nodeId: string,
  graph: { nodes?: any[]; edges?: any[] },
  changesByPath: Map<string, string>,
  nodesById?: Map<string, any>,
  opts: { graceMs?: number } = {}
): EvidenceStaleNote | null {
  if (changesByPath.size === 0) return null;
  const graceMs = opts.graceMs ?? EVIDENCE_STALE_GRACE_MS_DEFAULT;
  const byId = nodesById ?? new Map((graph.nodes ?? []).map((n: any) => [n.id, n]));
  const node = byId.get(nodeId);
  const verifiedAt = typeof node?.generated_at === "string" ? node.generated_at : null;
  if (!verifiedAt) return null;
  const verifiedMs = Date.parse(verifiedAt);
  if (!Number.isFinite(verifiedMs)) return null;
  const stale: { path: string; changed_at: string }[] = [];
  for (const e of graph.edges ?? []) {
    if (e?.from !== nodeId || typeof e?.type !== "string" || !KNOWLEDGE_TO_FILE_EDGES.has(e.type)) continue;
    const toNode = byId.get(e.to);
    const derived = typeof e.to === "string" && e.to.startsWith("file:") ? e.to.split(":").slice(2).join(":") : null;
    const filePath =
      toNode && typeof toNode.path === "string" ? toNode.path : derived && derived.length > 0 ? derived : null;
    if (!filePath) continue;
    const changedAt = changesByPath.get(filePath);
    if (!changedAt) continue;
    const changedMs = Date.parse(changedAt);
    if (!Number.isFinite(changedMs)) continue;
    if (changedMs - verifiedMs > graceMs && !stale.some((s) => s.path === filePath)) {
      stale.push({ path: filePath, changed_at: changedAt });
    }
  }
  if (stale.length === 0) return null;
  return {
    paths: stale.slice(0, 5),
    verified_at: verifiedAt,
    note:
      `⚠ evidence file(s) changed AFTER this node was last verified (${verifiedAt}) — ` +
      "the file is the source of truth; verify against it before relying on this node. " +
      "If the node still holds, op:update it (advances generated_at and clears this note)."
  };
}
