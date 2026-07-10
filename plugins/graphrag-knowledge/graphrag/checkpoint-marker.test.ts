// checkpoint-mark verb (ask-state.json 予約キー方式) の単体テスト。
// 実行: node --experimental-strip-types --test graphrag/checkpoint-marker.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildVaultFiles } from "./build-vault.ts";
import { cacheDirForVault } from "./cli-env.ts";
import { CHECKPOINT_STATE_KEY } from "./cli-ask-state.ts";
import { CHECKPOINT_TTL_MS, extractFirstAction, runCheckpointMark } from "./checkpoint-marker.ts";

const FIXED_TS = "2026-01-01T00:00:00.000Z";

// nodes から <root>/.graphrag/vault レイアウトの一時 vault を書き出す。
// cacheDirForVault(vaultDir) = <root>/.graphrag/cache に ask-state.json が書かれる。
function makeVault(nodes: any[]): { root: string; vaultDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "ckpt-"));
  const vaultDir = path.join(root, ".graphrag", "vault");
  for (const f of buildVaultFiles({ generated_at: FIXED_TS, nodes, edges: [] })) {
    const abs = path.join(vaultDir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  return { root, vaultDir };
}

// runCheckpointMark を stdout/stderr を捕捉して実行する。
async function runCaptured(argv: string[]): Promise<{ out: string; err: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as any).write = (chunk: any) => { outChunks.push(String(chunk)); return true; };
  (process.stderr as any).write = (chunk: any) => { errChunks.push(String(chunk)); return true; };
  try {
    await runCheckpointMark(argv);
  } finally {
    (process.stdout as any).write = origOut;
    (process.stderr as any).write = origErr;
  }
  return { out: outChunks.join(""), err: errChunks.join("") };
}

function askStateFile(vaultDir: string): string {
  return path.join(cacheDirForVault(vaultDir), "ask-state.json");
}

const validRaw =
  "current focus: 復元機構を予約キー方式へ移行中\n" +
  "next: graphrag/checkpoint-marker.ts:42 の runCheckpointMark を検証つきに直す\n" +
  "blocker: なし\n" +
  "touched: graphrag/checkpoint-marker.ts";

// --- extractFirstAction 単体 ---

test("extractFirstAction: next 同一行の後続を採る", () => {
  assert.equal(
    extractFirstAction("current focus: X\nnext: do the thing at foo.ts:10"),
    "do the thing at foo.ts:10"
  );
});

test("extractFirstAction: 同一行が空なら直後の最初の非空行 (箇条書き記号を剥がす)", () => {
  assert.equal(
    extractFirstAction("next:\n\n  - foo.ts:10 を直す\n  - 次\n"),
    "foo.ts:10 を直す"
  );
  assert.equal(extractFirstAction("next:\n1) まず A"), "まず A");
});

test("extractFirstAction: next 行が無い / 一手が空なら空文字", () => {
  assert.equal(extractFirstAction("current focus: X"), "");
  assert.equal(extractFirstAction("next:\n\n"), "");
});

// --- 正常系 ---

test("正常系: 予約キーが書かれ他キーは保たれ stdout JSON が返る", async () => {
  const { root, vaultDir } = makeVault([
    { id: "investigation:s:live", type: "Investigation", title: "現役", state: "active", raw_content: validRaw }
  ]);
  try {
    // 既存の ask 連打キーを先に置き、予約キー追記で消えないことを確かめる。
    const stateFp = askStateFile(vaultDir);
    mkdirSync(path.dirname(stateFp), { recursive: true });
    writeFileSync(stateFp, JSON.stringify({ abcd1234: { count: 3, last_at: 111 } }));

    const { out, err } = await runCaptured(["--investigation", "investigation:s:live", "--vault", vaultDir]);

    const printed = JSON.parse(out);
    assert.equal(printed.investigation_id, "investigation:s:live");
    assert.equal(printed.first_action, "graphrag/checkpoint-marker.ts:42 の runCheckpointMark を検証つきに直す");
    assert.equal(printed.ttl_minutes, CHECKPOINT_TTL_MS / 60_000);
    assert.equal(printed.state_path, stateFp);
    assert.ok(Number.isFinite(Date.parse(printed.marked_at)));
    assert.match(err, /checkpoint state:/);

    const onDisk = JSON.parse(readFileSync(stateFp, "utf8"));
    const entry = onDisk[CHECKPOINT_STATE_KEY];
    assert.equal(entry.investigation_id, "investigation:s:live");
    assert.equal(entry.first_action, printed.first_action);
    assert.equal(entry.work_state, validRaw);
    assert.equal(entry.count, 0);
    assert.equal(typeof entry.last_at, "number");
    assert.equal(typeof entry.cwd, "string");
    // 既存キーは保たれている。
    assert.deepEqual(onDisk.abcd1234, { count: 3, last_at: 111 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- hard-error 群 ---

test("--investigation 無しで hard-error", async () => {
  const { root, vaultDir } = makeVault([
    { id: "investigation:s:live", type: "Investigation", title: "x", state: "active", raw_content: validRaw }
  ]);
  try {
    await assert.rejects(() => runCheckpointMark(["--vault", vaultDir]), /requires --investigation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vault 未指定で hard-error", async () => {
  const saved = process.env.GRAPHRAG_VAULT_DIR;
  delete process.env.GRAPHRAG_VAULT_DIR;
  try {
    await assert.rejects(
      () => runCheckpointMark(["--investigation", "investigation:s:x"]),
      /requires a vault/
    );
  } finally {
    if (saved !== undefined) process.env.GRAPHRAG_VAULT_DIR = saved;
  }
});

test("ノード不在で hard-error", async () => {
  const { root, vaultDir } = makeVault([
    { id: "investigation:s:live", type: "Investigation", title: "x", state: "active", raw_content: validRaw }
  ]);
  try {
    await assert.rejects(
      () => runCheckpointMark(["--investigation", "investigation:s:missing", "--vault", vaultDir]),
      /investigation:s:missing.*does not exist/s
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Investigation でない type で hard-error", async () => {
  const { root, vaultDir } = makeVault([
    { id: "decision:s:d", type: "Decision", title: "決定", summary: "s" }
  ]);
  try {
    await assert.rejects(
      () => runCheckpointMark(["--investigation", "decision:s:d", "--vault", vaultDir]),
      /not Investigation/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active でない Investigation で hard-error", async () => {
  const { root, vaultDir } = makeVault([
    { id: "investigation:s:done", type: "Investigation", title: "終結", state: "closed", raw_content: validRaw }
  ]);
  try {
    await assert.rejects(
      () => runCheckpointMark(["--investigation", "investigation:s:done", "--vault", vaultDir]),
      /not active/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw_content が空で hard-error", async () => {
  const { root, vaultDir } = makeVault([
    { id: "investigation:s:live", type: "Investigation", title: "x", state: "active" }
  ]);
  try {
    await assert.rejects(
      () => runCheckpointMark(["--investigation", "investigation:s:live", "--vault", vaultDir]),
      /empty raw_content/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("next: 行が無いと hard-error", async () => {
  const { root, vaultDir } = makeVault([
    { id: "investigation:s:live", type: "Investigation", title: "x", state: "active",
      raw_content: "current focus: X を調べている\nblocker: なし" }
  ]);
  try {
    await assert.rejects(
      () => runCheckpointMark(["--investigation", "investigation:s:live", "--vault", vaultDir]),
      /no "next:" line/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("first_action が空で hard-error", async () => {
  const { root, vaultDir } = makeVault([
    // next: の後続 (同一行・後続行とも) が空。直後に非空行が無いので first_action は空。
    { id: "investigation:s:live", type: "Investigation", title: "x", state: "active",
      raw_content: "current focus: X\nnext:" }
  ]);
  try {
    await assert.rejects(
      () => runCheckpointMark(["--investigation", "investigation:s:live", "--vault", vaultDir]),
      /first action is empty/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw_content が 8KB 超で hard-error", async () => {
  const bigRaw =
    "current focus: X\nnext: foo.ts:1 を直す\nblocker: " + "y".repeat(9000);
  const { root, vaultDir } = makeVault([
    { id: "investigation:s:live", type: "Investigation", title: "x", state: "active", raw_content: bigRaw }
  ]);
  try {
    await assert.rejects(
      () => runCheckpointMark(["--investigation", "investigation:s:live", "--vault", vaultDir]),
      /8KB|ConversationChunk/s
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
