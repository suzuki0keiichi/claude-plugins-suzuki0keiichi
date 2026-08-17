/**
 * rail-common: 読み導線レール (rail-prompt / rail-touch) の共有部品。
 *
 * レールの契約 (ノイズ予算が最優先の設計制約):
 *   - 注入はコンテキストに直接載るため、上限を固定する: 最大 RAIL_MAX_ITEMS 件・
 *     合計 RAIL_TOTAL_BUDGET_CHARS 字 (超過は件数を削って収める)。沈黙時はゼロ。
 *   - セッション内 seen-set (rail-seen-<session>.json) で同一ノードの再注入と
 *     同一ファイルへの再走査を抑止する。ask-state.json とは別ファイル —
 *     ask-state は原子書きだが read-modify-write 競合で更新が消え得る +
 *     セッション次元を持たないため、相乗りすると並列セッションで誤抑制する。
 *     セッション別ファイルなら並列競合が構造的に消える (同一セッションの hook は直列)。
 *   - 全発火 (注入も沈黙も) を rail-log.jsonl に1行ずつ記録する — 注入率・
 *     ノイズ率・文字数を実測で語るための土台。ログは自動ローテーション。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { cacheDirForVault } from "./cli-env.ts";
import { appendJsonlLog } from "./lane-log.ts";

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
  updated_at: number;
  injected_node_ids: string[];
  touched_files: string[];
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
  return path.join(cacheDir, `rail-seen-${sessionId}.json`);
}

export function loadRailSeen(cacheDir: string, sessionId: string): RailSeen {
  const fp = railSeenPath(cacheDir, sessionId);
  try {
    if (existsSync(fp)) {
      const parsed = JSON.parse(readFileSync(fp, "utf8"));
      if (parsed && typeof parsed === "object") {
        return {
          session_id: sessionId,
          updated_at: Number(parsed.updated_at) || 0,
          injected_node_ids: Array.isArray(parsed.injected_node_ids) ? parsed.injected_node_ids.filter((x: unknown) => typeof x === "string") : [],
          touched_files: Array.isArray(parsed.touched_files) ? parsed.touched_files.filter((x: unknown) => typeof x === "string") : []
        };
      }
    }
  } catch {
    // 壊れていれば空から (fail-open)
  }
  return { session_id: sessionId, updated_at: 0, injected_node_ids: [], touched_files: [] };
}

/**
 * 原子書き込み (tmp+rename、saveAskState と同じ規約) + 兄弟の期限切れ seen ファイル掃除。
 * 同一セッションの hook 発火はターン内で直列なので、同一ファイルへの競合は実質起きない。
 */
export function saveRailSeen(cacheDir: string, seen: RailSeen, now: number = Date.now()): void {
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const fp = railSeenPath(cacheDir, seen.session_id);
  const tmp = `${fp}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ...seen, updated_at: now }, null, 2));
  renameSync(tmp, fp);
  // 期限切れセッションの seen ファイルを掃除 (best-effort)
  try {
    for (const name of readdirSync(cacheDir)) {
      if (!name.startsWith("rail-seen-") || !name.endsWith(".json")) continue;
      const sibling = path.join(cacheDir, name);
      if (sibling === fp) continue;
      const st = statSync(sibling);
      if (now - st.mtimeMs >= SEEN_TTL_MS) unlinkSync(sibling);
    }
  } catch {
    // 掃除失敗はレール動作に影響させない
  }
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
