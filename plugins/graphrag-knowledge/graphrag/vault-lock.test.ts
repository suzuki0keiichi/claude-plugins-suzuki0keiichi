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

test("stale ロック（同一ホスト・死んだ PID）は奪える", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "vlock-"));
  const { writeFileSync } = await import("node:fs");
  const os = await import("node:os");
  writeFileSync(path.join(stateDir, "vault.lock"), JSON.stringify({ pid: 999999999, ts: 0, hostname: os.hostname() }));
  let ran = false;
  await withVaultLock(stateDir, () => { ran = true; }, { staleMs: 1000 });
  assert.equal(ran, true);
});

test("別ホストの新鮮なロックはローカル PID 不在でも即奪取しない (mtime + staleMs で裁定)", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "vlock-remote-"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path.join(stateDir, "vault.lock"), JSON.stringify({ pid: 999999999, ts: Date.now(), hostname: "other-host.example.com" }));
  await assert.rejects(
    () => withVaultLock(stateDir, () => {}, { staleMs: 600_000, timeoutMs: 150, pollMs: 20 }),
    /timeout/i,
    "別ホストの PID がローカルに無くても mtime が新鮮なら奪わず待つ"
  );
});

test("生きた PID のロックは年齢だけでは奪わない (旧 30s 閾値相当でも待って timeout)", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "vlock-"));
  const { writeFileSync } = await import("node:fs");
  const os = await import("node:os");
  // 生きた保持者 (このプロセス自身) が 60s 前に取得したロック。旧実装は 30s 超で
  // 奪ってしまい、git commit が遅いだけの生きた writer と二重書きになった。
  writeFileSync(
    path.join(stateDir, "vault.lock"),
    JSON.stringify({ pid: process.pid, ts: Date.now() - 60_000, hostname: os.hostname(), nonce: "some-nonce" })
  );
  await assert.rejects(
    () => withVaultLock(stateDir, () => {}, { timeoutMs: 150, pollMs: 20 }),
    /timeout/i
  );
});

test("生きた PID でも絶対上限 (staleMs) 超過なら奪える (PID 再利用への保険)", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "vlock-"));
  const { writeFileSync } = await import("node:fs");
  const os = await import("node:os");
  writeFileSync(
    path.join(stateDir, "vault.lock"),
    JSON.stringify({ pid: process.pid, ts: Date.now() - 5_000, hostname: os.hostname(), nonce: "old-nonce" })
  );
  let ran = false;
  await withVaultLock(stateDir, () => { ran = true; }, { staleMs: 1_000 });
  assert.equal(ran, true);
});

test("finally は自分の PID のロックだけを消す (奪われた後に他者のロックを消さない)", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "vlock-"));
  const { writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const lockPath = path.join(stateDir, "vault.lock");
  await withVaultLock(stateDir, () => {
    // 実行中に (絶対上限超過等で) 別プロセスがロックを奪った想定: 中身が他者の PID になる。
    writeFileSync(lockPath, JSON.stringify({ pid: 999999999, ts: Date.now() }));
  });
  assert.ok(existsSync(lockPath), "他者のロックを finally で unlink しない");
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, 999999999);
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
  const { writeFileSync, unlinkSync } = await import("node:fs");
  let store = "v0";
  const lockPath = path.join(stateDir, "vault.lock");
  const writer = (async () => {
    // 実 writer と同じく lock 保持下で書込窓を開く (applyMutationToVault は withVaultLock
    // 内で beginVaultWrite する)。lock 不在の奇数 seq は「静的な crash residue」として
    // 読んで良い、が現在の判定 (writerCrashed) — lock を持たない生きた writer は実運用に
    // 存在しないので、生き writer の再現には lock が必須。
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    const b = beginVaultWrite(stateDir);
    await new Promise((r) => setTimeout(r, 20));
    store = "v1";
    endVaultWrite(stateDir, b);
    unlinkSync(lockPath);
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

test("withVaultLock は hostname を lock ファイルに書き込む (P2-C)", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "vlock-host-"));
  const { readFileSync } = await import("node:fs");
  const os = await import("node:os");
  const lockPath = path.join(stateDir, "vault.lock");
  let lockContent: string | undefined;
  await withVaultLock(stateDir, () => {
    lockContent = readFileSync(lockPath, "utf8");
  });
  assert.ok(lockContent, "lock ファイルが書かれている");
  const info = JSON.parse(lockContent!);
  assert.equal(info.hostname, os.hostname(), "hostname が lock に含まれる");
});

test("finally は PID が同じでも nonce が異なるロックを消さない (P3-I: ABA 対策)", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "vlock-nonce-"));
  const { writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const lockPath = path.join(stateDir, "vault.lock");
  await withVaultLock(stateDir, () => {
    // 実行中に (stale 超過等で) 別プロセスがロックを奪った想定。
    // 同一 PID だが異なる nonce のロックに差し替える (PID 再利用シナリオ)。
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), nonce: "other-holder-nonce", hostname: "other-host" }));
  });
  // 現行の実装は PID のみで判定するので、PID が一致して unlink してしまう。
  // 修正後は nonce 不一致で unlink しない。
  assert.ok(existsSync(lockPath), "nonce が異なるロックを finally で unlink しない");
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).nonce, "other-holder-nonce");
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

test("readVaultConsistent は別ホストの writer (seq 奇数 + ローカルに存在しない PID) を crash と誤認しない", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "vseq-remote-"));
  const { writeFileSync } = await import("node:fs");
  beginVaultWrite(stateDir); // seq 奇数
  writeFileSync(path.join(stateDir, "vault.lock"), JSON.stringify({ pid: 999999999, ts: Date.now(), hostname: "other-host.example.com" }));
  await assert.rejects(
    () => readVaultConsistent(stateDir, () => "DATA", { timeoutMs: 150, pollMs: 10 }),
    /timeout/i,
    "別ホストの PID がローカルに無くても crash bypass せず待つ"
  );
});
