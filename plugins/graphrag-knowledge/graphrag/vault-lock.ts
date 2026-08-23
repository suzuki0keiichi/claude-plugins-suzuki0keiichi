import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync, statSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type LockInfo = { pid: number; ts: number; hostname?: string; nonce?: string };

/**
 * pid が生きているか (kill 0 プローブ。EPERM = 存在するが権限なし → 生存扱い)。
 * cli-ask-state.ts の lock の stale 判定も共有する (state dir は機械ローカル前提 —
 * cli-env.ts 参照 — なので pid ベース判定が成立する)。
 */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

function isStale(lockPath: string, staleMs: number, graceMs: number): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    // ファイルが消えていた → 取得可能（= stale 扱い）。
    return true;
  }
  try {
    const info = JSON.parse(raw) as LockInfo;
    // hostname 一致時だけ PID 生存確認を使う — pidAlive はローカルの PID テーブルを
    // 見るため、別ホストの PID には使えない (存在しない → 即 stale と誤判定する)。
    if (info.hostname && info.hostname === os.hostname()) {
      if (!pidAlive(info.pid)) return true;
      // PID alive + 同一ホスト → staleMs は PID 再利用への保険の絶対上限 (既定 10 分)。
      return Date.now() - info.ts > staleMs;
    }
    // hostname 不一致 / 不明 (旧フォーマット) → mtime + staleMs 判定にフォールバック。
    try {
      const mtimeMs = statSync(lockPath).mtimeMs;
      return Date.now() - mtimeMs > staleMs;
    } catch {
      return true; // stat 失敗 (消えた) → 取得可能
    }
  } catch {
    // 空/部分/壊れた lock: 別プロセスが openSync 直後・metadata 書き込み前かもしれない。
    // mtime が grace 内なら「生成途中」とみなして待つ（奪わない）。grace 超過なら壊れた残骸として奪う。
    try {
      const mtimeMs = statSync(lockPath).mtimeMs;
      return Date.now() - mtimeMs > graceMs;
    } catch {
      // この瞬間にファイルが消えた → 取得可能。
      return true;
    }
  }
}

function seqPath(stateDir: string) { return path.join(stateDir, "vault.seq"); }

export function readSeq(stateDir: string): number {
  try { return parseInt(readFileSync(seqPath(stateDir), "utf8").trim(), 10) || 0; }
  catch { return 0; }
}

function writeSeqAtomic(stateDir: string, n: number): void {
  const p = seqPath(stateDir);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, String(n));
  renameSync(tmp, p);
}

/** writes の前に呼ぶ。現在値(偶数想定)を+1して奇数=書込中にし、その値を返す。 */
export function beginVaultWrite(stateDir: string): number {
  const cur = readSeq(stateDir);
  const odd = cur % 2 === 0 ? cur + 1 : cur; // 既に奇数なら据え置き(再入防止)
  writeSeqAtomic(stateDir, odd);
  return odd;
}

/** writes の後に呼ぶ。beginVaultWrite が返した奇数値+1=偶数=完了にする。 */
export function endVaultWrite(stateDir: string, beganAt: number): void {
  writeSeqAtomic(stateDir, beganAt + 1);
}

/**
 * writer が書込途中(seq 奇数)で hard crash したか (= 奇数 seq が「静的な残骸」か) を
 * 判定する。実運用では seq 奇数窓は常に vault.lock 保持と同時 (applyMutationToVault は
 * withVaultLock 内で beginVaultWrite する)。endVaultWrite は withVaultLock の finally より
 * 前に走るので、生きた writer の奇数窓では必ず lock が存在し PID も生きている。よって:
 *  - ロックが在り PID が死んでいる = writer が begin と end の間で hard crash。
 *  - ロックが無い = 生きた writer は居ない (writer は lock 取得後にしか begin しない)。
 *    crash 残骸が後続 writer に stale 回収された後の奇数 seq、または失敗した回復 run が
 *    意図的に残した crash residue (mutate-vault 敵対レビュー指摘A: 前世代の torn 回復
 *    材料を焼かないため endVaultWrite を呼ばず lock だけ解放する) — どちらも静的状態
 *    なので読んで良い。読み後の再検査 (seq 不変 + 本判定の再実行) が、直後に開始した
 *    writer との競合を弾く。
 * 生成途中 (空・壊れ) のロックだけは live 扱い (= bypass せず待つ) で保守的にする。
 */
function writerCrashed(stateDir: string): boolean {
  const lockPath = path.join(stateDir, "vault.lock");
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return true; // ロック無し + seq 奇数 (呼び出し文脈) = 静的な residue → 読んで良い
  }
  try {
    const info = JSON.parse(raw) as LockInfo;
    // hostname が明示的に異なる場合だけ PID 検査を skip (別ホストの PID テーブルは見えない)。
    // hostname 欠落 (v1.40.2 以前の旧フォーマット) は常にローカル lock なので pidAlive が有効。
    // ※ isStale は hostname 欠落時に mtime フォールバックがあるため一律 skip で安全だが、
    //   writerCrashed にはフォールバックが無く、skip すると旧形式 lock の crash recovery が
    //   永久に進まない — 両関数の hostname 欠落時の挙動が異なるのはこの構造差による。
    if (info.hostname && info.hostname !== os.hostname()) return false;
    return !pidAlive(info.pid);
  } catch {
    return false; // 生成途中の空/壊れロック → 別 writer が取得中かもしれない → 待つ
  }
}

export async function readVaultConsistent<T>(
  stateDir: string,
  read: () => T,
  opts: { pollMs?: number; timeoutMs?: number } = {}
): Promise<T> {
  return (await readVaultConsistentWithSeq(stateDir, read, opts)).data;
}

/**
 * readVaultConsistent の「確定した seq 値も返す」variant (issue #27)。
 * 返る seq は読みの前後で不変だった値 = この snapshot の世代番号。index builder は
 * これを payload に打刻し、rename 直前の「自分より新しい snapshot の index を
 * 踏み潰さない」比較に使う。crash bypass 経路では取り残された奇数値をそのまま返す
 * (それがその静的状態の世代)。
 */
export async function readVaultConsistentWithSeq<T>(
  stateDir: string,
  read: () => T,
  opts: { pollMs?: number; timeoutMs?: number } = {}
): Promise<{ data: T; seq: number }> {
  const pollMs = opts.pollMs ?? 10;
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  for (;;) {
    const s1 = readSeq(stateDir);
    if (s1 % 2 === 1) {
      // 書込中(奇数)。生きた writer が書いている間は待つ(torn read 回避)。だが writer が
      // crash して seq が奇数のまま取り残された場合は永久に待たず、その時点の静的状態を読む。
      // (read→seq 再読→なお crash 中、で安定を確認。間に別 writer が取得していたら s2 が
      //  変わるか crash 判定が外れるので破棄して通常経路へ戻る。)
      if (writerCrashed(stateDir)) {
        const data = read();
        const s2 = readSeq(stateDir);
        if (s1 === s2 && writerCrashed(stateDir)) return { data, seq: s1 };
      }
      if (Date.now() > deadline) throw new Error("readVaultConsistent timeout (write in progress)");
      await new Promise((r) => setTimeout(r, pollMs)); continue;
    }
    const data = read();
    const s2 = readSeq(stateDir);
    if (s1 === s2) return { data, seq: s1 };
    if (Date.now() > deadline) throw new Error("readVaultConsistent timeout (kept changing)");
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function withVaultLock<T>(
  stateDir: string,
  fn: () => Promise<T> | T,
  opts: { staleMs?: number; timeoutMs?: number; pollMs?: number; graceMs?: number } = {}
): Promise<T> {
  // stale 判定の主軸は「PID 死亡」。staleMs は PID 再利用への保険の絶対上限。
  const staleMs = opts.staleMs ?? 600_000;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 25;
  const graceMs = opts.graceMs ?? 2_000;
  const lockPath = path.join(stateDir, "vault.lock");
  const deadline = Date.now() + timeoutMs;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      if (isStale(lockPath, staleMs, graceMs)) {
        try { unlinkSync(lockPath); } catch { /* 競合は次ループで再判定 */ }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`vault lock timeout (${lockPath})`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  const nonce = `${process.pid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now(), hostname: os.hostname(), nonce } satisfies LockInfo));
    return await fn();
  } finally {
    try { closeSync(fd); } catch { /* noop */ }
    // 自分の PID + nonce が入ったロックだけを消す。絶対上限超過等で誰かに奪われていた場合、
    // 無条件 unlink は「奪った側のロック」を消してしまい三重目の writer を招く。
    // PID のみの比較では PID 再利用で他者の lock を消す (ABA) ため、nonce も検証する。
    try {
      const cur = JSON.parse(readFileSync(lockPath, "utf8")) as LockInfo;
      if (cur.pid === process.pid && cur.nonce === nonce) unlinkSync(lockPath);
    } catch { /* 消えている/壊れている → 触らない (残骸は stale 判定が回収する) */ }
  }
}
