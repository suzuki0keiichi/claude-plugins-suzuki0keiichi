import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withVaultLock, beginVaultWrite, endVaultWrite, readVaultConsistent, readSeq } from "./vault-lock.ts";

test("withVaultLock は同一 stateDir の書きを直列化する", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "vlock-"));
  const order: string[] = [];
  const slow = (tag: string, ms: number) =>
    withVaultLock(stateDir, async () => {
      order.push(`${tag}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${tag}:end`);
    });
  await Promise.all([slow("A", 40), slow("B", 10)]);
  const aStart = order.indexOf("A:start"), aEnd = order.indexOf("A:end");
  const bStart = order.indexOf("B:start"), bEnd = order.indexOf("B:end");
  const serial =
    (aStart < aEnd && aEnd < bStart && bStart < bEnd) ||
    (bStart < bEnd && bEnd < aStart && aStart < aEnd);
  assert.ok(serial, `not serialized: ${order.join(",")}`);
});

test("stale ロック（死んだ PID）は奪える", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "vlock-"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path.join(stateDir, "vault.lock"), JSON.stringify({ pid: 999999999, ts: 0 }));
  let ran = false;
  await withVaultLock(stateDir, () => { ran = true; }, { staleMs: 1000 });
  assert.equal(ran, true);
});

test("新しい空ロック（生成途中）は奪わず待つ→timeout する", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "vlock-"));
  const { writeFileSync } = await import("node:fs");
  // mtime = now の空ファイル: 別プロセスが openSync 直後・metadata 書き込み前を模す
  writeFileSync(path.join(stateDir, "vault.lock"), "");
  await assert.rejects(
    () => withVaultLock(stateDir, () => {}, { timeoutMs: 120, pollMs: 20 }),
    /timeout/i
  );
});

test("古い空ロック（grace 超過）は奪える", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "vlock-"));
  const { writeFileSync, utimesSync } = await import("node:fs");
  const lockPath = path.join(stateDir, "vault.lock");
  writeFileSync(lockPath, "");
  const old = Date.now() / 1000 - 10; // grace を十分に超えた過去に backdate
  utimesSync(lockPath, old, old);
  let ran = false;
  await withVaultLock(stateDir, () => { ran = true; }, { graceMs: 1000 });
  assert.equal(ran, true);
});

test("版印は書込前後で偶数→奇数→偶数に進む", () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "vseq-"));
  assert.equal(readSeq(stateDir), 0);
  const before = beginVaultWrite(stateDir);
  assert.equal(readSeq(stateDir) % 2, 1, "in-progress は奇数");
  endVaultWrite(stateDir, before);
  assert.equal(readSeq(stateDir) % 2, 0, "完了は偶数");
});

test("readVaultConsistent は書込中スナップショットを返さず最終値を返す", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "vseq-"));
  let store = "v0";
  const writer = (async () => {
    const b = beginVaultWrite(stateDir);
    await new Promise((r) => setTimeout(r, 20));
    store = "v1";
    endVaultWrite(stateDir, b);
  })();
  const got = await readVaultConsistent(stateDir, () => store, { pollMs: 5 });
  await writer;
  assert.equal(got, "v1");
});

test("readVaultConsistent は crash した writer (seq 奇数 + 死んだ PID のロック) から回復して読みを返す", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "vseq-crash-"));
  const { writeFileSync } = await import("node:fs");
  // writer が書込開始 (seq 奇数) 後に hard crash: endVaultWrite が走らず seq は奇数のまま、
  // 死んだ PID のロックが残骸として残る。旧実装はここで読みが timeout し続け回復しなかった。
  beginVaultWrite(stateDir);
  writeFileSync(path.join(stateDir, "vault.lock"), JSON.stringify({ pid: 999999999, ts: Date.now() }));
  const start = Date.now();
  const got = await readVaultConsistent(stateDir, () => "DATA", { timeoutMs: 5000, pollMs: 5 });
  assert.equal(got, "DATA", "放棄された静的状態を読んで返す");
  assert.ok(Date.now() - start < 1000, "timeout を待たず速やかに回復する (永久に詰まらない)");
});

test("readVaultConsistent は生きた writer がロック保持中なら bypass せず待つ (torn read 回避)", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "vseq-live-"));
  const { writeFileSync } = await import("node:fs");
  beginVaultWrite(stateDir); // seq 奇数
  // 生きた保持者 = このテストプロセス自身の pid。crash ではないので bypass してはいけない。
  writeFileSync(path.join(stateDir, "vault.lock"), JSON.stringify({ pid: process.pid, ts: Date.now() }));
  await assert.rejects(
    () => readVaultConsistent(stateDir, () => "DATA", { timeoutMs: 150, pollMs: 10 }),
    /timeout/i
  );
});
