import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fingerprintQuestion, bumpCallCount, loadAskState, saveAskState, gcAskState, recordAskHits, readRecentHitIds } from "./cli-ask-state.ts";

test("fingerprintQuestion is stable and short", () => {
  const a = fingerprintQuestion("hello world");
  const b = fingerprintQuestion("hello world");
  const c = fingerprintQuestion("HELLO WORLD");
  assert.equal(a, b);
  assert.notEqual(a, c); // case-sensitive (LLM が大文字小文字を変えたら別質問とみなす)
  assert.match(a, /^[a-f0-9]{8,}$/);
});

test("bumpCallCount increments per question, returns new count", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "askstate-"));
  try {
    assert.equal(bumpCallCount("q1", dir), 1);
    assert.equal(bumpCallCount("q1", dir), 2);
    assert.equal(bumpCallCount("q2", dir), 1);
    assert.equal(bumpCallCount("q1", dir), 3);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("loadAskState returns empty when file missing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "askstate-"));
  try {
    const state = loadAskState(dir);
    assert.deepEqual(state, {});
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("saveAskState then loadAskState round-trips", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "askstate-"));
  try {
    const now = Date.now();
    saveAskState(dir, { abc12345: { count: 2, last_at: now } });
    const loaded = loadAskState(dir);
    assert.equal(loaded.abc12345.count, 2);
    assert.equal(loaded.abc12345.last_at, now);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── E4 ask-trail (hits 記録) ──────────────────────────────────────────────
test("recordAskHits stores top<=3 ids and readRecentHitIds reads them back", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "askstate-"));
  try {
    recordAskHits("q1", ["a", "b", "c", "d"], dir); // 4件 → 上位3に切る
    assert.deepEqual(readRecentHitIds(dir), ["a", "b", "c"]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("readRecentHitIds dedupes and orders newest-first across questions", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "askstate-"));
  try {
    const t0 = Date.now();
    recordAskHits("q1", ["a", "b"], dir, t0);
    recordAskHits("q2", ["b", "c"], dir, t0 + 1000); // newer; b は dedupe
    const ids = readRecentHitIds(dir);
    assert.deepEqual(ids, ["b", "c", "a"], "newest entry first, dedupe");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("readRecentHitIds caps at 15", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "askstate-"));
  try {
    const t0 = Date.now();
    for (let i = 0; i < 10; i += 1) {
      recordAskHits(`q${i}`, [`n${i}a`, `n${i}b`, `n${i}c`], dir, t0 + i);
    }
    assert.equal(readRecentHitIds(dir).length, 15);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("readRecentHitIds excludes TTL-expired hits", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "askstate-"));
  try {
    const now = Date.now();
    recordAskHits("fresh", ["f1"], dir, now);
    recordAskHits("stale", ["s1"], dir, now - 25 * 60 * 60 * 1000); // 25h 前
    assert.deepEqual(readRecentHitIds(dir, 24 * 60 * 60 * 1000, now), ["f1"]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("recordAskHits preserves count; bumpCallCount preserves hits", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "askstate-"));
  try {
    bumpCallCount("q1", dir); // count=1
    bumpCallCount("q1", dir); // count=2
    recordAskHits("q1", ["x", "y"], dir); // hits 追加, count 保持
    const state = loadAskState(dir);
    const fp = fingerprintQuestion("q1");
    assert.equal(state[fp].count, 2, "record は count を消さない");
    assert.deepEqual(state[fp].hits, ["x", "y"]);
    bumpCallCount("q1", dir); // count=3, hits 保持
    assert.deepEqual(loadAskState(dir)[fp].hits, ["x", "y"], "bump は hits を消さない");
    assert.equal(loadAskState(dir)[fp].count, 3);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("gcAskState removes entries older than TTL", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "askstate-"));
  try {
    const now = Date.now();
    const old = now - 25 * 60 * 60 * 1000; // 25 時間前
    saveAskState(dir, {
      fresh: { count: 1, last_at: now },
      stale: { count: 5, last_at: old }
    });
    gcAskState(dir, now);
    const loaded = loadAskState(dir);
    assert.ok(loaded.fresh);
    assert.equal(loaded.stale, undefined);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
