import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync, existsSync, statSync, renameSync } from "node:fs";
import path from "node:path";

type LockInfo = { pid: number; ts: number };

function pidAlive(pid: number): boolean {
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
    // metadata が正常に読めた場合: PID 死亡 or staleMs 超過なら stale。
    if (!pidAlive(info.pid)) return true;
    if (Date.now() - info.ts > staleMs) return true;
    return false;
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
 * writer が書込途中(seq 奇数)で hard crash したかを判定する。
 * 実運用では seq 奇数窓は常に vault.lock 保持と同時 (applyMutationToVault は withVaultLock
 * 内で beginVaultWrite する)。endVaultWrite は withVaultLock の finally より前に走るので、
 * 正常完了/例外では「seq 偶数 → ロック解放」の順になる。よって「ロックが在り、その PID が
 * 死んでいる」= writer が beginVaultWrite と endVaultWrite の間で hard crash し、seq が
 * 奇数のまま取り残された、と判定できる。この時もう誰も vault を書いていないので読んで良い。
 * ロックが無い/生成途中(空・壊れ)の場合は live 扱い(= bypass せず待つ)で保守的にする。
 */
function writerCrashed(stateDir: string): boolean {
  const lockPath = path.join(stateDir, "vault.lock");
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return false; // ロック無し(実運用では seq 偶数のはず) → bypass しない
  }
  try {
    const info = JSON.parse(raw) as LockInfo;
    return !pidAlive(info.pid); // ロック在り + PID 死亡 → crash 確定
  } catch {
    return false; // 生成途中の空/壊れロック → 別 writer が取得中かもしれない → 待つ
  }
}

export async function readVaultConsistent<T>(
  stateDir: string,
  read: () => T,
  opts: { pollMs?: number; timeoutMs?: number } = {}
): Promise<T> {
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
        if (s1 === s2 && writerCrashed(stateDir)) return data;
      }
      if (Date.now() > deadline) throw new Error("readVaultConsistent timeout (write in progress)");
      await new Promise((r) => setTimeout(r, pollMs)); continue;
    }
    const data = read();
    const s2 = readSeq(stateDir);
    if (s1 === s2) return data;
    if (Date.now() > deadline) throw new Error("readVaultConsistent timeout (kept changing)");
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function withVaultLock<T>(
  stateDir: string,
  fn: () => Promise<T> | T,
  opts: { staleMs?: number; timeoutMs?: number; pollMs?: number; graceMs?: number } = {}
): Promise<T> {
  const staleMs = opts.staleMs ?? 30_000;
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
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() } satisfies LockInfo));
    return await fn();
  } finally {
    try { closeSync(fd); } catch { /* noop */ }
    try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch { /* noop */ }
  }
}
