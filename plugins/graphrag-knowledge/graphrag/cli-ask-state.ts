import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { cacheDirForVault, cacheDirUnder, consumerCacheDirForVault, type VaultMode } from "./cli-env.ts";

const TTL_MS = 24 * 60 * 60 * 1000; // 24 時間
const STATE_FILENAME = "ask-state.json";

// checkpoint 復元の予約キー。8 文字 fingerprint (fingerprintQuestion) とは長さで
// 衝突しない (14 文字・アンダースコア境界)。checkpoint-mark verb が書き、clear-restore
// フックが one-shot で消費する。ask の連打カウントとは別レーンで ask-state.json に同居する。
export const CHECKPOINT_STATE_KEY = "__checkpoint__";

// hits: その質問の直近の top≤3 ヒットノード id (E4 ask-trail)。premise 候補提案が
// 「直近で見ていたノード」を引くために使う。既存 count/last_at の entry に同居する。
export type AskStateEntry = { count: number; last_at: number; hits?: string[] };

// checkpoint 予約キーの値。既存 entry の読み手を壊さないための不変条件:
//   - count/last_at を必ず持つ (bumpCallCount / gcAskState / readRecentHitIds が触る)。
//     特に last_at (ms epoch) が無いと 24h GC の NaN 比較で不死化する。
//   - hits を持たない (hits?: never)。readRecentHitIds の Array.isArray(e.hits) で
//     自然に除外され、checkpoint が premise 候補として拾われない。
export type CheckpointStateEntry = {
  count: number;
  last_at: number;
  hits?: never;
  marked_at: string;        // ISO 8601。フック側の 60 分失効判定に使う。
  cwd: string;              // checkpoint 実行時の cwd。フック側の厳密一致判定に使う。
  investigation_id: string;
  first_action: string;     // next: から抽出した「最初の一手」。
  work_state: string;       // Investigation.raw_content 全文。
};

export type AskState = Record<string, AskStateEntry | CheckpointStateEntry>;

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

/**
 * ask-state (呼び出し回数 / ask-trail) の置き場所を解決する単一の関数。
 * 読み手 (runAsk) と書き手 (mutate-vault の ask-trail 読み) が別ロジックで解決すると、
 * GRAPHRAG_STATE_DIR を設定した環境では ask が記録した場所と書き込み側が読む場所が
 * ずれ、write 側の precheck advisory が常に「ヒット無し」の誤情報になる (#10)。
 * 両側はこの関数を経由すること。
 *   1. GRAPHRAG_STATE_DIR 明示 → その cache/ (E1)
 *   2. readonly mode → 消費側ローカルの cache/external/<hash>/ (E3)。ローカル root が
 *      見つからなければ null = 永続化 skip (勝手にディレクトリを掘らない)
 *   3. それ以外 → vault を保持する .graphrag の cache/
 */
export function resolveAskStateDir(vaultDir: string, mode: VaultMode | null = null): string | null {
  const explicit = process.env.GRAPHRAG_STATE_DIR;
  if (explicit) return cacheDirUnder(explicit);
  if (mode === "readonly") return consumerCacheDirForVault(vaultDir);
  return cacheDirForVault(vaultDir);
}

export function loadAskState(baseDir: string): AskState {
  let fp = stateFilePath(baseDir);
  // E1 legacy fallback: 置き場所が cache/ へ移った後も、移行前の ask-state.json が
  // state dir (.graphrag) 直下に残っていれば読む。書き込み (saveAskState) は常に
  // 新パス (baseDir 直下) へ行くので、一度書けば以後は新パスが読まれる。
  if (!existsSync(fp) && path.basename(path.resolve(baseDir)) === "cache") {
    const legacy = stateFilePath(path.dirname(path.resolve(baseDir)));
    if (existsSync(legacy)) fp = legacy;
  }
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
  // 原子書き込み: 同ディレクトリの一時ファイルへ書いてから rename する。
  // rename は同一 FS 上で原子的なので、並行 load→save が競合しても読み手は
  // 常に「古い完全な JSON」か「新しい完全な JSON」を見る (中途半端な切れた
  // ファイルを読まない)。完全な排他ではない — 片方の更新が消える可能性は残るが、
  // lock を持ち込まずに「壊れた JSON を読ませない」ところまでを保証する。
  const fp = stateFilePath(baseDir);
  const tmp = `${fp}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, fp);
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
