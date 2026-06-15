import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const TTL_MS = 24 * 60 * 60 * 1000; // 24 時間
const STATE_FILENAME = "ask-state.json";

// hits: その質問の直近の top≤3 ヒットノード id (E4 ask-trail)。premise 候補提案が
// 「直近で見ていたノード」を引くために使う。既存 count/last_at の entry に同居する。
export type AskStateEntry = { count: number; last_at: number; hits?: string[] };
export type AskState = Record<string, AskStateEntry>;

/**
 * 質問文を 8 文字の hex fingerprint に。case-sensitive、whitespace は trim のみ。
 * LLM が大文字小文字を変えたら別質問として扱う = 連打抑止が緩むがそれは LLM 側の意図的な変更。
 */
export function fingerprintQuestion(question: string): string {
  const normalized = question.trim();
  return createHash("sha1").update(normalized).digest("hex").slice(0, 8);
}

function stateFilePath(baseDir: string): string {
  return path.join(baseDir, STATE_FILENAME);
}

export function loadAskState(baseDir: string): AskState {
  const fp = stateFilePath(baseDir);
  if (!existsSync(fp)) return {};
  try {
    const text = readFileSync(fp, "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as AskState;
  } catch {
    return {};
  }
}

export function saveAskState(baseDir: string, state: AskState): void {
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  writeFileSync(stateFilePath(baseDir), JSON.stringify(state, null, 2));
}

export function gcAskState(baseDir: string, now: number = Date.now()): void {
  const state = loadAskState(baseDir);
  const fresh: AskState = {};
  for (const [key, entry] of Object.entries(state)) {
    if (now - entry.last_at < TTL_MS) fresh[key] = entry;
  }
  saveAskState(baseDir, fresh);
}

/**
 * question の call count を +1 して返す。GC も同時実行 (TTL 超過 entry を削除)。
 */
export function bumpCallCount(question: string, baseDir: string, now: number = Date.now()): number {
  const fp = fingerprintQuestion(question);
  const state = loadAskState(baseDir);
  // inline GC
  for (const key of Object.keys(state)) {
    if (now - state[key].last_at >= TTL_MS) delete state[key];
  }
  const prev = state[fp];
  const next = (prev?.count ?? 0) + 1;
  // hits は record 専用なので bump では保持する (連打カウントが hits を消さない)。
  state[fp] = { count: next, last_at: now, ...(prev?.hits ? { hits: prev.hits } : {}) };
  saveAskState(baseDir, state);
  return next;
}

/**
 * 質問の直近ヒット (top≤3 ノード id) を ask-state entry に記録する (E4 ask-trail)。
 * fingerprint は bumpCallCount と同じ鍵。既存 count/last_at は保ち、hits だけ差し替える。
 * last_at も更新して TTL/GC の対象に乗せる (古い hits は GC で自然に落ちる)。
 */
export function recordAskHits(
  question: string,
  ids: string[],
  baseDir: string,
  now: number = Date.now()
): void {
  const fp = fingerprintQuestion(question);
  const state = loadAskState(baseDir);
  // inline GC (bumpCallCount と同じ TTL 掃除を同居させる)。
  for (const key of Object.keys(state)) {
    if (now - state[key].last_at >= TTL_MS) delete state[key];
  }
  const prev = state[fp];
  const hits = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string").slice(0, 3);
  state[fp] = { count: prev?.count ?? 0, last_at: now, hits };
  saveAskState(baseDir, state);
}

/**
 * TTL 内の全 entry の hits を新しい順 (last_at 降順) に走査し、dedupe して ≤15 件返す。
 * premise 候補提案 (E0 suggestions.premise_candidates) が「直近で見ていたノード」を引く用途。
 * TTL 超過 entry は対象外 (期限切れの古いヒットは引かない)。
 */
export function readRecentHitIds(
  baseDir: string,
  ttlMs: number = TTL_MS,
  now: number = Date.now()
): string[] {
  const state = loadAskState(baseDir);
  const entries = Object.values(state)
    .filter((e) => Array.isArray(e.hits) && e.hits.length > 0 && now - e.last_at < ttlMs)
    .sort((a, b) => b.last_at - a.last_at);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    for (const id of e.hits ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= 15) return out;
    }
  }
  return out;
}
