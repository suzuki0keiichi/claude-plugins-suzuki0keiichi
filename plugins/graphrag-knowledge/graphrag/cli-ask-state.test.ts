import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fingerprintQuestion, bumpCallCount, loadAskState, saveAskState, gcAskState, recordAskHits, readRecentHitIds, resolveAskStateDir, checkpointStateKey, withAskStateLock, CHECKPOINT_STATE_KEY } from "./cli-ask-state.ts";

const execFileP = promisify(execFile);

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

// ── E1: cache/ 移行の legacy 読み取り fallback ──

test("loadAskState: cache/ に無ければ legacy (.graphrag 直下) を読み、保存は新パスへ", () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "askstate-legacy-"));
  try {
    const now = Date.now();
    // 移行前の ask-state.json が state dir 直下に残っている状態
    writeFileSync(
      path.join(stateDir, "ask-state.json"),
      JSON.stringify({ legacyfp: { count: 2, last_at: now } })
    );
    const cacheDir = path.join(stateDir, "cache");
    // 読み: legacy が読まれる
    const st = loadAskState(cacheDir);
    assert.equal(st["legacyfp"]?.count, 2, "legacy の状態が読まれる");
    // 書き: bump は legacy を引き継ぎつつ新パス (cache/) へ書く
    const n = bumpCallCount("brand new question", cacheDir, now);
    assert.equal(n, 1);
    assert.ok(existsSync(path.join(cacheDir, "ask-state.json")), "以後は新パスに書かれる");
    const migrated = JSON.parse(readFileSync(path.join(cacheDir, "ask-state.json"), "utf8"));
    assert.equal(migrated["legacyfp"]?.count, 2, "legacy のエントリも新パスに引き継がれる");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── #10: resolveAskStateDir — 読み手 (ask) と書き手 (mutate-vault) を同じ解決に一本化 ──

test("resolveAskStateDir: GRAPHRAG_STATE_DIR が明示されていれば最優先でその cache/ を返す", () => {
  const prevEnv = process.env.GRAPHRAG_STATE_DIR;
  const dir = mkdtempSync(path.join(tmpdir(), "askstate-resolve-explicit-"));
  try {
    process.env.GRAPHRAG_STATE_DIR = dir;
    const resolved = resolveAskStateDir("/some/unrelated/vault/dir");
    assert.equal(resolved, path.join(dir, "cache"));
  } finally {
    if (prevEnv === undefined) delete process.env.GRAPHRAG_STATE_DIR;
    else process.env.GRAPHRAG_STATE_DIR = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAskStateDir: GRAPHRAG_STATE_DIR 未設定なら vault の隣の .graphrag/cache", () => {
  const prevEnv = process.env.GRAPHRAG_STATE_DIR;
  delete process.env.GRAPHRAG_STATE_DIR;
  const root = mkdtempSync(path.join(tmpdir(), "askstate-resolve-vault-"));
  try {
    const vault = path.join(root, "vault");
    mkdirSync(vault, { recursive: true });
    const resolved = resolveAskStateDir(vault);
    assert.equal(resolved, path.join(root, ".graphrag", "cache"));
  } finally {
    if (prevEnv !== undefined) process.env.GRAPHRAG_STATE_DIR = prevEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveAskStateDir: GRAPHRAG_STATE_DIR 設定時、共有解決関数で記録したヒットは同じ関数経由で読める", () => {
  // #10 再現防止: ask 側 (record) と書き込み側 (read) が別ロジックで state dir を
  // 決めると、GRAPHRAG_STATE_DIR を設定した環境では永遠にヒットが見えなくなっていた。
  const prevEnv = process.env.GRAPHRAG_STATE_DIR;
  const dir = mkdtempSync(path.join(tmpdir(), "askstate-resolve-rw-"));
  try {
    process.env.GRAPHRAG_STATE_DIR = dir;
    const vaultDir = "/some/vault/that/does/not/matter/once/GRAPHRAG_STATE_DIR/is/set";
    const askDirForRecord = resolveAskStateDir(vaultDir)!;
    recordAskHits("q1", ["decision:s:a"], askDirForRecord);
    // 別々の呼び出しでも (readonly mode 等の分岐が無い限り) 同じ解決結果になる。
    const askDirForRead = resolveAskStateDir(vaultDir)!;
    assert.equal(askDirForRead, askDirForRecord);
    assert.deepEqual(readRecentHitIds(askDirForRead), ["decision:s:a"]);
  } finally {
    if (prevEnv === undefined) delete process.env.GRAPHRAG_STATE_DIR;
    else process.env.GRAPHRAG_STATE_DIR = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #29: checkpoint の identity 別キー化 ──────────────────────────────────

test("checkpointStateKey: __checkpoint__:<hash> 形式で identity 毎に安定した別キーを返す", () => {
  const a = checkpointStateKey("/proj/a");
  const b = checkpointStateKey("/proj/b");
  assert.match(a, /^__checkpoint__:[0-9a-f]{12}$/);
  assert.equal(a, checkpointStateKey("/proj/a"), "同一 identity なら安定");
  assert.notEqual(a, b, "別 identity なら別キー");
  assert.ok(a.startsWith(`${CHECKPOINT_STATE_KEY}:`), "旧単一キーの prefix 拡張");
});

// checkpoint 形の entry を作る (last_at = marked 時刻)。
const ckptEntry = (at: number) => ({
  count: 0,
  last_at: at,
  marked_at: new Date(at).toISOString(),
  cwd: "/x",
  investigation_id: "investigation:s:i",
  first_action: "f",
  work_state: "current focus: X\nnext: f"
});

test("#29 inline GC (bumpCallCount): checkpoint エントリは 60 分 TTL、ask エントリは従来 24h TTL", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "askstate-ckpt-gc-"));
  try {
    const now = Date.now();
    const kOld = checkpointStateKey("/proj/old");
    const kFresh = checkpointStateKey("/proj/fresh");
    saveAskState(dir, {
      [kOld]: ckptEntry(now - 2 * 60 * 60 * 1000),          // 2h 前 → 60 分 TTL 超過で消える
      [kFresh]: ckptEntry(now - 30 * 60 * 1000),             // 30 分前 → fresh なので残る
      [CHECKPOINT_STATE_KEY]: ckptEntry(now - 2 * 60 * 60 * 1000), // 旧単一キーも checkpoint TTL
      askold00: { count: 1, last_at: now - 25 * 60 * 60 * 1000 },  // 25h → 24h GC で消える
      askfresh: { count: 1, last_at: now - 2 * 60 * 60 * 1000 }    // 2h → ask TTL 内で残る
    });
    bumpCallCount("gc q", dir, now);
    const st = loadAskState(dir);
    assert.equal(st[kOld], undefined, "失効 checkpoint entry は掃除される");
    assert.ok(st[kFresh], "fresh checkpoint entry は消えない");
    assert.equal(st[CHECKPOINT_STATE_KEY], undefined, "旧単一キーも 60 分 TTL で掃除される");
    assert.equal(st.askold00, undefined, "24h 超の ask entry は従来どおり消える");
    assert.ok(st.askfresh, "24h 内の ask entry は checkpoint TTL に巻き込まれない");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#29 inline GC (recordAskHits / gcAskState) も checkpoint 60 分 TTL を適用する", () => {
  const now = Date.now();
  for (const run of ["record", "gc"] as const) {
    const dir = mkdtempSync(path.join(tmpdir(), "askstate-ckpt-gc2-"));
    try {
      const kOld = checkpointStateKey("/proj/old");
      const kFresh = checkpointStateKey("/proj/fresh");
      saveAskState(dir, {
        [kOld]: ckptEntry(now - 61 * 60 * 1000),
        [kFresh]: ckptEntry(now - 59 * 60 * 1000),
        askfresh: { count: 1, last_at: now - 2 * 60 * 60 * 1000 }
      });
      if (run === "record") recordAskHits("gc q", ["a"], dir, now);
      else gcAskState(dir, now);
      const st = loadAskState(dir);
      assert.equal(st[kOld], undefined, `${run}: 失効 checkpoint entry は掃除される`);
      assert.ok(st[kFresh], `${run}: fresh checkpoint entry は残る`);
      assert.ok(st.askfresh, `${run}: ask entry は 24h TTL のまま`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ── #29: 実並行 lost update (mkdir ベース lock) ───────────────────────────

const SRC_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "cli-ask-state.ts")).href;
const CHILD_FLAGS = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module"];

// 子プロセス: 同一 state dir へ bumpCallCount を n 回。
const bumpChild = (dir: string, n: number) =>
  execFileP(process.execPath, [
    ...CHILD_FLAGS,
    "-e",
    `const { bumpCallCount } = await import(process.argv[1]);\n` +
    `for (let i = 0; i < ${n}; i++) bumpCallCount("parallel question", process.argv[2]);\n`,
    SRC_URL,
    dir
  ]);

// 子プロセス: withAskStateLock で checkpoint entry の RMW を n 回 (checkpoint-mark 相当)。
const ckptChild = (dir: string, key: string, n: number) =>
  execFileP(process.execPath, [
    ...CHILD_FLAGS,
    "-e",
    `const m = await import(process.argv[1]);\n` +
    `const dir = process.argv[2], key = process.argv[3];\n` +
    `for (let i = 0; i < ${n}; i++) {\n` +
    `  m.withAskStateLock(dir, () => {\n` +
    `    const s = m.loadAskState(dir);\n` +
    `    s[key] = { count: 0, last_at: Date.now(), marked_at: new Date().toISOString(), cwd: "/x", investigation_id: "investigation:s:i", first_action: "f", work_state: "w" };\n` +
    `    m.saveAskState(dir, s);\n` +
    `  });\n` +
    `}\n`,
    SRC_URL,
    dir,
    key
  ]);

test("#29 実並行: 8 プロセス × 50 bump の最終 count がちょうど 400 (lock が lost update を防ぐ)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "askstate-parallel-"));
  try {
    await Promise.all(Array.from({ length: 8 }, () => bumpChild(dir, 50)));
    const st = loadAskState(dir);
    assert.equal(st[fingerprintQuestion("parallel question")]?.count, 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#29 実並行: bump と checkpoint 書き込みが競合しても双方の更新が残る", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "askstate-parallel-mix-"));
  try {
    const kA = checkpointStateKey("/proj/a");
    const kB = checkpointStateKey("/proj/b");
    await Promise.all([
      ...Array.from({ length: 4 }, () => bumpChild(dir, 50)),
      ckptChild(dir, kA, 20),
      ckptChild(dir, kB, 20)
    ]);
    const st = loadAskState(dir);
    assert.equal(st[fingerprintQuestion("parallel question")]?.count, 200, "bump が checkpoint 書き込みに消されない");
    assert.ok(st[kA], "checkpoint entry A が bump に消されない");
    assert.ok(st[kB], "checkpoint entry B が bump に消されない");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
