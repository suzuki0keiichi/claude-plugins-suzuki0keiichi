import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { cacheDirForVault, cacheDirUnder, consumerCacheDirForVault, type VaultMode } from "./cli-env.ts";

const TTL_MS = 24 * 60 * 60 * 1000; // 24 時間
const STATE_FILENAME = "ask-state.json";

// checkpoint 復元の予約キーの stem。8 文字 fingerprint (fingerprintQuestion) とは長さで
// 衝突しない (14 文字・アンダースコア境界)。checkpoint-mark verb が書き、clear-restore
// フックが one-shot で消費する。ask の連打カウントとは別レーンで ask-state.json に同居する。
// #29 以降の実キーは identity 別の `__checkpoint__:<hash>` (checkpointStateKey)。この stem
// 単体のキーは旧フォーマット (単一予約キー時代) で、フック側が読み互換で消費する。
export const CHECKPOINT_STATE_KEY = "__checkpoint__";

// checkpoint 予約キーの失効窓 (60 分)。主の消費はフック側の one-shot 削除であり、これは
// 「checkpoint-mark を撃ったが clear しなかった」古い意図の暴発防止と、identity 別キーで
// map が育たないための inline GC (下の gcInPlace) の両方に使う。
// hooks/clear-restore.mjs は依存ゼロ方針でこの値を import せず複製する (相互参照コメントを両側に置く)。
export const CHECKPOINT_TTL_MS = 60 * 60 * 1000; // 60 分

/**
 * checkpoint 予約キーを identity (session_dir ?? git root ?? cwd を realpath 正規化した文字列) 別に
 * 分ける (#29)。単一キーだと同じ vault を共有する複数 session の checkpoint が後勝ちで消え、
 * 別 project の /clear に判定前消費 (先食い) される。hash は衝突回避のためだけの短縮で、
 * 復元フックはキーの suffix を解釈しない (照合は entry の session_dir/root/cwd で行う)。
 */
export function checkpointStateKey(identity: string): string {
  return `${CHECKPOINT_STATE_KEY}:${createHash("sha1").update(identity).digest("hex").slice(0, 12)}`;
}

/** key が checkpoint 予約キー (旧単一キー / identity 別キー) か。TTL の使い分けに使う。 */
export function isCheckpointStateKey(key: string): boolean {
  return key === CHECKPOINT_STATE_KEY || key.startsWith(`${CHECKPOINT_STATE_KEY}:`);
}

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
  // --- 同一性判定 (hooks/clear-restore.mjs) の三段フォールバック ---
  // 精度の高い順に session_dir → root → cwd。上位が在ればそれ「だけ」で判定し、下位へは降りない
  // (下位は上位より粗いので、精密な宣言が不一致なのに粗い一致で救うと別プロジェクトを誤復元する)。
  //
  // [1] checkpoint を撃ったセッションのプロジェクトディレクトリ。`checkpoint-mark --session-dir` で
  // 明示的に渡された値 (realpath 解決済み)。出所は graphrag-checkpoint skill: モデルが自身の
  // システムプロンプトに持つ Primary working directory を渡す。Bash ツール内の CLI には
  // CLAUDE_PROJECT_DIR が渡らず PWD は `cd` で汚染されるので、これが「Claude Code が
  // プロジェクトと認識している位置」を知る唯一の確かな経路。フック側の input.cwd と直接照合できる
  // ため最精密 — 在れば単独で判定し、不一致なら root へフォールバックせず拒否する
  // (モノレポのサブディレクトリを開いた別セッションは root が同じでも別プロジェクト位置)。
  session_dir?: string;
  // [2] checkpoint 実行時のプロジェクトルート (findProjectRoot: realpath から上へ .git を探した最寄り)。
  // session_dir が無い entry で使う近似。フック側は自分の cwd から解決した root との realpath 一致で
  // 「同じ作業か」を判定する。git 外なら省略される (= 旧フォーマット entry と同じ扱い → cwd 一致判定)。
  root?: string;
  // [3] checkpoint 実行時の cwd。AI が `cd <subdir>` して CLI を撃つとセッションルートと食い違うので、
  // 同一性判定の主役ではない (session_dir も root も無い旧 entry / git 外のためのフォールバックと診断表示用)。
  cwd: string;
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
  // ファイルを読まない)。これ単体は排他ではない — read-modify-write の lost update は
  // 呼び手側が withAskStateLock で囲んで防ぐ (#29。read-only の読み手は lock 不要)。
  const fp = stateFilePath(baseDir);
  const tmp = `${fp}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, fp);
}

// ── mkdir ベースの軽量 lock (#29) ─────────────────────────────────────────
// saveAskState の tmp+rename は「壊れた JSON を読ませない」までしか保証せず、load→save の
// read-modify-write は並行実行で片方の更新が消える (lost update: bump 同士 / bump と
// checkpoint-mark / フックの consume 書き戻し、が実際に競合する)。RMW 全経路をこの lock で囲む。
//
// プロトコル (hooks/clear-restore.mjs に依存ゼロ方針で同一実装を複製する — 変える時は両側を直すこと):
//   - lock は <baseDir>/ask-state.lock という「ディレクトリ」。mkdir は既存時に EEXIST で
//     失敗するため、素の node だけで原子的な取得になる (恒久ファイル種は増えない — owner ファイル
//     も一時 dir 内のみ)。
//   - 取得直後に lock dir 内へ owner ファイル (pid + ランダム nonce + 取得時刻) を書く (#41)。
//     mkdir 直後の dir mtime は新しいので、owner を書くまでの間に stale 判定されることはない。
//   - 取得失敗時は 25ms 間隔でリトライ。lock の mtime (owner ファイル、無ければ dir) が 5 秒より
//     古ければ残骸 (クラッシュした保持者) とみなして奪取する。正常な保持区間は ms オーダーなので
//     誤奪取しない。奪取前に「最初に読んだ nonce と現在の nonce が同一のままであること」を再確認する
//     (read→rm 間に別プロセスが奪取済みなら nonce が変わる — 二重奪取の大半を検出。残る窓は
//     mkdir の原子性が受け止める: 同時奪取しても mkdir に勝つのは一方だけ)。owner ファイルが
//     無い/読めない lock は owner 不明 — stale なら削除可とする (owner 書き込み失敗や旧実装の残骸)。
//     削除は owner ファイル → dir の順。dir が空でなければ rmdir が ENOTEMPTY で失敗し retry に戻る。
//   - release (finally) は owner ファイルの nonce が自分と一致する場合のみ削除する (#41 ABA:
//     停止中に stale 奪取されていたら lock はもう他者のもの — 不一致/読めない場合は触らない。
//     従来は無条件 rmdir だったため、奪取者の lock を消して第三者を進入させ lost update が再発した)。
//   - 10 秒でタイムアウトし「lock なしで続行」する (best-effort)。ask も復元フックも
//     ブロックで殺すより、最悪ケースで従来同等 (lost update の可能性) に落ちる方を選ぶ。
const LOCK_DIRNAME = "ask-state.lock";
const LOCK_OWNER_FILENAME = "owner.json";
const LOCK_STALE_MS = 5_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 25;

// owner ファイルの nonce を読む。無い/読めない/形式不正は null (= owner 不明)。
function readLockOwnerNonce(ownerPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(ownerPath, "utf8"));
    return typeof parsed?.nonce === "string" ? parsed.nonce : null;
  } catch {
    return null;
  }
}

// 同期 sleep。Atomics.wait はメインスレッドの素 node で使える (timer も child_process も不要)。
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer が使えない環境では即リトライ (busy loop 側に倒す)。
  }
}

/**
 * ask-state.json への read-modify-write を排他する。fn は同期で短く保つこと
 * (保持が LOCK_STALE_MS を超えると他プロセスに残骸として奪取される)。
 */
export function withAskStateLock<T>(baseDir: string, fn: () => T): T {
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  const lockDir = path.join(baseDir, LOCK_DIRNAME);
  const ownerPath = path.join(lockDir, LOCK_OWNER_FILENAME);
  const nonce = `${process.pid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let held = false;
  while (!held) {
    try {
      mkdirSync(lockDir); // 非 recursive: 既存なら EEXIST → 原子的な取得判定
      held = true;
      try {
        // 取得の証明を即座に書く。失敗しても保持は続行 — owner 不明 lock として振る舞う
        // (stale 化したら他者に無条件奪取され、release も nonce 不一致で触らない)。
        writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, nonce, acquired_at: Date.now() }));
      } catch { /* best-effort */ }
    } catch (e: any) {
      if (e?.code !== "EEXIST") break; // 権限等の想定外 — lock なしで続行 (best-effort)
      // タイムアウトは全 retry 経路 (stale 奪取の continue 含む) が通る位置で判定する。
      // 旧実装は stale 分岐の continue が判定を素通りし、消せない残骸で無限 busy loop になった。
      if (Date.now() > deadline) break; // タイムアウト — lock なしで続行
      try {
        const seenNonce = readLockOwnerNonce(ownerPath); // null = owner 不明
        let mtimeMs: number;
        try {
          mtimeMs = statSync(ownerPath).mtimeMs; // 保持者の証明の鮮度で判定
        } catch {
          mtimeMs = statSync(lockDir).mtimeMs; // owner 無し lock は dir の鮮度で判定
        }
        if (Date.now() - mtimeMs > LOCK_STALE_MS) {
          // 奪取直前に nonce が変わっていないか再確認 (#41: 別プロセスが先に奪取して保持中の
          // lock を消さない)。owner 不明 (null) かつ stale はそのまま削除可。
          if (readLockOwnerNonce(ownerPath) === seenNonce) {
            rmSync(ownerPath, { force: true });
            rmdirSync(lockDir); // 残骸を奪取 (rmdir の競合は片方が ENOENT/ENOTEMPTY → 次ループで再判定)
          }
          continue;
        }
      } catch {
        continue; // stat/rm 中に消えた等 → すぐ再取得を試みる
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        // 自分の nonce のままの時だけ解放する (#41 ABA)。不一致/読めない場合は停止中に
        // stale 奪取済み — その lock はもう他者のものなので触らない。
        if (readLockOwnerNonce(ownerPath) === nonce) {
          rmSync(ownerPath, { force: true });
          rmdirSync(lockDir);
        }
      } catch { /* 奪取済み等 — 触らない */ }
    }
  }
}

// inline GC: ask entry は 24h、checkpoint 予約キー (identity 別で増える) は 60 分で掃除する。
// last_at はどちらも必ず持つ不変条件 (CheckpointStateEntry のコメント参照)。
function gcInPlace(state: AskState, now: number): void {
  for (const key of Object.keys(state)) {
    const ttl = isCheckpointStateKey(key) ? CHECKPOINT_TTL_MS : TTL_MS;
    if (now - state[key].last_at >= ttl) delete state[key];
  }
}

export function gcAskState(baseDir: string, now: number = Date.now()): void {
  withAskStateLock(baseDir, () => {
    const state = loadAskState(baseDir);
    gcInPlace(state, now);
    saveAskState(baseDir, state);
  });
}

/**
 * question の call count を +1 して返す。GC も同時実行 (TTL 超過 entry を削除)。
 */
export function bumpCallCount(question: string, baseDir: string, now: number = Date.now()): number {
  const fp = fingerprintQuestion(question);
  return withAskStateLock(baseDir, () => {
    const state = loadAskState(baseDir);
    gcInPlace(state, now);
    const prev = state[fp] as AskStateEntry | undefined;
    const next = (prev?.count ?? 0) + 1;
    // hits は record 専用なので bump では保持する (連打カウントが hits を消さない)。
    state[fp] = { count: next, last_at: now, ...(prev?.hits ? { hits: prev.hits } : {}) };
    saveAskState(baseDir, state);
    return next;
  });
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
  withAskStateLock(baseDir, () => {
    const state = loadAskState(baseDir);
    gcInPlace(state, now);
    const prev = state[fp] as AskStateEntry | undefined;
    const hits = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string").slice(0, 3);
    state[fp] = { count: prev?.count ?? 0, last_at: now, hits };
    saveAskState(baseDir, state);
  });
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
