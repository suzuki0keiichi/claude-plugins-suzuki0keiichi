/**
 * rail-common: 読み導線レール (rail-prompt / rail-touch / rail-read) の共有部品。
 * ファイル系レール (touch/read) の判定エンジン railFileLane もここが正本 —
 * verb 側 (rail-touch.ts / rail-read.ts) は列挙キーと文面だけを渡す薄い皮で、
 * 修正が片方のミラーにだけ当たる事故を構造的に防ぐ。
 *
 * レールの契約 (ノイズ予算が最優先の設計制約):
 *   - 注入はコンテキストに直接載るため、上限を固定する: 最大 RAIL_MAX_ITEMS 件・
 *     合計 RAIL_TOTAL_BUDGET_CHARS 字 (超過は件数を削って収める)。沈黙時はゼロ。
 *   - セッション内 seen-set (rail-seen-<session>.jsonl) で同一ノードの再注入と
 *     同一ファイルへの再走査を抑止する。ストアは append-only JSONL —
 *     read-modify-write は並列 Read (1ターン複数 Read は最頻出パターン) で
 *     last-writer-wins になり dedup が消える実測があるため禁止。O_APPEND の
 *     小行追記はアトミックで、読みは全行の和集合。旧形式 rail-seen-<session>.json
 *     (v1.41.0 以前) も読み側で合流させる (アップグレード跨ぎセッションの互換)。
 *   - seen の書き込み失敗は注入を殺さない (fail-open): 劣化は「再注入があり得る」
 *     までで、失敗は rail-log に seen-save-error として残す。
 *   - 全発火 (注入も沈黙も) を rail-log.jsonl に1行ずつ記録する — 注入率・
 *     ノイズ率・文字数を実測で語るための土台。ログは自動ローテーション。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { cacheDirForVault } from "./cli-env.ts";
import { appendJsonlLog } from "./lane-log.ts";
import { importVault } from "./import-vault.ts";
import { canonicalType } from "./schema.ts";
import { KNOWLEDGE_TO_FILE_EDGES } from "./crosscut-map.ts";

export const RAIL_MAX_ITEMS = 3;
export const RAIL_TOTAL_BUDGET_CHARS = 700;
export const RAIL_TITLE_CLIP = 90;
export const RAIL_HEADLINE_CLIP = 90;

const SEEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface RailItem {
  id: string;
  type: string;
  title: string;
  state?: string;
  headline?: string;
}

export interface RailSeen {
  session_id: string;
  injected_node_ids: string[];
  touched_files: string[];
  read_files: string[];
}

export function resolveRailCacheDir(): string | null {
  const vaultDir = process.env.GRAPHRAG_VAULT_DIR;
  if (!vaultDir) return null;
  return cacheDirForVault(vaultDir);
}

/** session id をファイル名に安全な形へ (hook 入力は信用しない)。 */
export function sanitizeSessionId(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  return s.length > 0 ? s : null;
}

export function railSeenPath(cacheDir: string, sessionId: string): string {
  return path.join(cacheDir, `rail-seen-${sessionId}.jsonl`);
}

function legacySeenPath(cacheDir: string, sessionId: string): string {
  return path.join(cacheDir, `rail-seen-${sessionId}.json`);
}

/** 読み = 全行の和集合。壊れた行は捨てる。旧形式 .json も合流 (fail-open)。 */
export function loadRailSeen(cacheDir: string, sessionId: string): RailSeen {
  const seen: RailSeen = { session_id: sessionId, injected_node_ids: [], touched_files: [], read_files: [] };
  const nodeIds = new Set<string>();
  const touched = new Set<string>();
  const read = new Set<string>();
  try {
    const legacy = legacySeenPath(cacheDir, sessionId);
    if (existsSync(legacy)) {
      const parsed = JSON.parse(readFileSync(legacy, "utf8"));
      for (const x of Array.isArray(parsed?.injected_node_ids) ? parsed.injected_node_ids : []) if (typeof x === "string") nodeIds.add(x);
      for (const x of Array.isArray(parsed?.touched_files) ? parsed.touched_files : []) if (typeof x === "string") touched.add(x);
      for (const x of Array.isArray(parsed?.read_files) ? parsed.read_files : []) if (typeof x === "string") read.add(x);
    }
  } catch {
    // 旧形式が壊れていても新形式は生きる
  }
  try {
    const fp = railSeenPath(cacheDir, sessionId);
    if (existsSync(fp)) {
      for (const line of readFileSync(fp, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e?.k === "node" && typeof e.id === "string") nodeIds.add(e.id);
          else if (e?.k === "file" && typeof e.f === "string") {
            if (e.l === "read") read.add(e.f);
            else if (e.l === "touch") touched.add(e.f);
          }
        } catch {
          // 壊れた行は捨てる
        }
      }
    }
  } catch {
    // 読めなければ空から (fail-open)
  }
  seen.injected_node_ids = [...nodeIds];
  seen.touched_files = [...touched];
  seen.read_files = [...read];
  return seen;
}

export interface RailSeenDelta {
  list?: "read" | "touch";
  files?: string[];
  nodeIds?: string[];
}

/**
 * append-only 追記 (並列安全)。成否を返し、決して throw しない —
 * seen の書き込み失敗でレール本体 (注入・ログ) を落とさないため。
 * ついでに期限切れセッションの seen ファイルを掃除する (best-effort)。
 */
export function appendRailSeen(cacheDir: string, sessionId: string, delta: RailSeenDelta, now: number = Date.now()): boolean {
  const lines: string[] = [];
  for (const f of delta.files ?? []) lines.push(JSON.stringify({ k: "file", l: delta.list ?? "read", f }));
  for (const id of delta.nodeIds ?? []) lines.push(JSON.stringify({ k: "node", id }));
  let ok = true;
  if (lines.length > 0) {
    try {
      if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
      appendFileSync(railSeenPath(cacheDir, sessionId), lines.join("\n") + "\n");
    } catch {
      ok = false;
    }
  }
  try {
    for (const name of readdirSync(cacheDir)) {
      if (!name.startsWith("rail-seen-") || !(name.endsWith(".json") || name.endsWith(".jsonl"))) continue;
      const sibling = path.join(cacheDir, name);
      if (sibling === railSeenPath(cacheDir, sessionId)) continue;
      const st = statSync(sibling);
      if (now - st.mtimeMs >= SEEN_TTL_MS) unlinkSync(sibling);
    }
  } catch {
    // 掃除失敗はレール動作に影響させない
  }
  return ok;
}

/** 発火記録 (注入/沈黙の両方)。1行1 JSON。ローテーション込みの追記は lane-log に一本化。 */
export function appendRailLog(cacheDir: string, entry: Record<string, unknown>, now: number = Date.now()): void {
  appendJsonlLog(cacheDir, "rail-log.jsonl", [entry], now);
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * 注入文の組み立て。予算 (件数・合計字数) をここで強制する — 呼び出し側が
 * 何件渡しても、出力は RAIL_MAX_ITEMS 件以内・RAIL_TOTAL_BUDGET_CHARS 字以内。
 * 1件も収まらなければ null (= 沈黙)。
 */
export function composeRailContext(
  tag: string,
  header: string,
  items: RailItem[]
): { context: string; ids: string[]; chars: number } | null {
  if (items.length === 0) return null;
  const lines: string[] = [];
  const ids: string[] = [];
  for (const item of items.slice(0, RAIL_MAX_ITEMS)) {
    const state = item.state ? ` (state: ${item.state})` : "";
    const headline = item.headline ? ` — ${clip(item.headline, RAIL_HEADLINE_CLIP)}` : "";
    lines.push(`- [${item.type}]${state} ${clip(item.title, RAIL_TITLE_CLIP)}${headline}`);
    ids.push(item.id);
  }
  let context = `<${tag}>\n${header}\n${lines.join("\n")}\n</${tag}>`;
  while (context.length > RAIL_TOTAL_BUDGET_CHARS && lines.length > 1) {
    lines.pop();
    ids.pop();
    context = `<${tag}>\n${header}\n${lines.join("\n")}\n</${tag}>`;
  }
  if (context.length > RAIL_TOTAL_BUDGET_CHARS) return null;
  return { context, ids, chars: context.length };
}

// ── ファイル系レールの共有実装 (touch/read の正本) ──────────────────────────

/** delta-check の TYPE_PRIORITY と同じ並び (Constraint 最優先)。依存を薄く保つため写し。 */
const TYPE_PRIORITY: Record<string, number> = {
  Constraint: 0, Decision: 1, OperationalKnowledge: 2, Risk: 3, Goal: 4, Investigation: 5
};

/** グラフから1ファイルへの逆引き (純粋関数、テスト対象)。 */
export function reverseLookupFile(
  graph: { nodes?: any[]; edges?: any[] },
  relPath: string
): RailItem[] {
  const nodesById = new Map<string, any>();
  for (const n of graph.nodes ?? []) {
    if (typeof n?.id === "string") nodesById.set(n.id, n);
  }
  const byNode = new Map<string, { node: any; edges: Set<string> }>();
  for (const e of graph.edges ?? []) {
    if (typeof e?.type !== "string" || !KNOWLEDGE_TO_FILE_EDGES.has(e.type)) continue;
    if (typeof e.from !== "string" || typeof e.to !== "string") continue;
    const toNode = nodesById.get(e.to);
    const derived = e.to.startsWith("file:") ? e.to.split(":").slice(2).join(":") : null;
    const filePath =
      toNode && typeof toNode.path === "string" ? toNode.path : derived && derived.length > 0 ? derived : null;
    if (filePath !== relPath) continue;
    const fromNode = nodesById.get(e.from);
    if (!fromNode) continue;
    if (!byNode.has(e.from)) byNode.set(e.from, { node: fromNode, edges: new Set() });
    byNode.get(e.from)!.edges.add(e.type);
  }
  const items = [...byNode.values()].map(({ node, edges }) => {
    const type = canonicalType(String(node.type)) ?? String(node.type);
    return {
      item: {
        id: String(node.id),
        type,
        title: String(node.title ?? node.id),
        ...(typeof node.state === "string" && node.state.length > 0 ? { state: node.state } : {}),
        ...(typeof node.summary === "string" && node.summary.length > 0 ? { headline: node.summary } : {})
      } as RailItem,
      priority: TYPE_PRIORITY[type] ?? 9,
      degree: edges.size
    };
  });
  items.sort((a, b) => a.priority - b.priority || b.degree - a.degree || a.item.id.localeCompare(b.item.id));
  return items.map((x) => x.item);
}

export interface RailFileLaneResult {
  status: "inject" | "silent";
  reason?: string;
  context?: string;
  ids?: string[];
  chars?: number;
}

export interface RailFileLaneSpec {
  rail: "read" | "touch";
  listKey: "read_files" | "touched_files";
  tag: string;
  header: (relPath: string) => string;
}

/**
 * touch/read 共通のレーン本体。seen 判定の正本はここ (hook 側の fast-path は
 * spawn 節約であって正しさの根拠ではない)。file-seen 沈黙もログに残す —
 * hook fast-path が通常この分岐を影にするため、ここに来た = hook と CLI の
 * 解決 (cache パス等) が食い違っている兆候であり、まさに観測したい事象。
 */
export function railFileLane(spec: RailFileLaneSpec, relPath: string, sessionId: string | null): RailFileLaneResult {
  const cacheDir = resolveRailCacheDir();
  const vaultDir = process.env.GRAPHRAG_VAULT_DIR;
  if (!vaultDir) return { status: "silent", reason: "no-vault" };

  const seen = cacheDir && sessionId ? loadRailSeen(cacheDir, sessionId) : null;
  if (seen && seen[spec.listKey].includes(relPath)) {
    if (cacheDir) appendRailLog(cacheDir, { rail: spec.rail, file: relPath, fired: false, reason: "file-seen", session: sessionId });
    return { status: "silent", reason: "file-seen" };
  }

  let graph: any;
  try {
    graph = importVault(vaultDir);
  } catch (e: any) {
    if (cacheDir) appendRailLog(cacheDir, { rail: spec.rail, fired: false, file: relPath, reason: `import-error: ${String(e?.message ?? e).slice(0, 120)}` });
    return { status: "silent", reason: "import-error" };
  }

  const seenIds = new Set(seen?.injected_node_ids ?? []);
  const all = reverseLookupFile(graph, relPath);
  const items = all.filter((i) => !seenIds.has(i.id)).slice(0, RAIL_MAX_ITEMS);
  const composed = composeRailContext(spec.tag, spec.header(relPath), items);

  // ヒットの有無に関わらずこのファイルは既読へ (配線ゼロのファイルに毎回 spawn しない)。
  // 追記失敗はレールを殺さず、ログに残す (fail-open の劣化 = 再注入があり得る、まで)。
  if (seen && cacheDir && sessionId) {
    const ok = appendRailSeen(cacheDir, sessionId, {
      list: spec.rail,
      files: [relPath],
      nodeIds: composed ? composed.ids : []
    });
    if (!ok) appendRailLog(cacheDir, { rail: spec.rail, file: relPath, reason: "seen-save-error", session: sessionId });
  }

  const logBase = { rail: spec.rail, file: relPath, wired: all.length, session: sessionId };
  if (!composed) {
    if (cacheDir) appendRailLog(cacheDir, { ...logBase, fired: false, reason: all.length === 0 ? "unwired" : "all-seen" });
    return { status: "silent", reason: all.length === 0 ? "unwired" : "all-seen" };
  }
  if (cacheDir) appendRailLog(cacheDir, { ...logBase, fired: true, ids: composed.ids, chars: composed.chars });
  return { status: "inject", context: composed.context, ids: composed.ids, chars: composed.chars };
}
