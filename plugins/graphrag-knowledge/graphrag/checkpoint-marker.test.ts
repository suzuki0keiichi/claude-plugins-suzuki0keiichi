// checkpoint-marker (one-shot 復元マーカー) の単体テスト。
// 実行: node --experimental-strip-types --test graphrag/checkpoint-marker.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CHECKPOINT_MARKER_TTL_MS,
  checkpointMarkerPath,
  consumeCheckpointMarker,
  readCheckpointMarker,
  runCheckpointMark,
  writeCheckpointMarker
} from "./checkpoint-marker.ts";

// 既定レイアウト <root>/.graphrag/vault の一時 fixture。
function makeVaultFixture(): { root: string; vaultDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "ckpt-marker-"));
  const vaultDir = path.join(root, ".graphrag", "vault");
  mkdirSync(vaultDir, { recursive: true });
  return { root, vaultDir };
}

test("checkpointMarkerPath は state dir の cache 配下を指す (既定レイアウト)", () => {
  const { root, vaultDir } = makeVaultFixture();
  try {
    assert.equal(
      checkpointMarkerPath(vaultDir),
      path.join(root, ".graphrag", "cache", "checkpoint-pending.json")
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write → read → consume の roundtrip", () => {
  const { root, vaultDir } = makeVaultFixture();
  try {
    const now = Date.UTC(2026, 0, 2, 3, 4, 5);
    const { marker_path, marker } = writeCheckpointMarker(vaultDir, "focus 一行", now);
    assert.equal(marker.marked_at, new Date(now).toISOString());
    assert.equal(marker.focus, "focus 一行");
    assert.ok(existsSync(marker_path));

    const read = readCheckpointMarker(vaultDir);
    assert.deepEqual(read, marker);

    consumeCheckpointMarker(vaultDir);
    assert.equal(existsSync(marker_path), false);
    assert.equal(readCheckpointMarker(vaultDir), null);
    // 二重消費してもエラーにならない
    consumeCheckpointMarker(vaultDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("壊れたマーカー (不正 JSON / marked_at 欠落) は null 扱い", () => {
  const { root, vaultDir } = makeVaultFixture();
  try {
    const fp = checkpointMarkerPath(vaultDir);
    mkdirSync(path.dirname(fp), { recursive: true });
    writeFileSync(fp, "not json");
    assert.equal(readCheckpointMarker(vaultDir), null);
    writeFileSync(fp, JSON.stringify({ focus: "marked_at が無い" }));
    assert.equal(readCheckpointMarker(vaultDir), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCheckpointMark は --vault でマーカーを書き JSON を出力する", async () => {
  const { root, vaultDir } = makeVaultFixture();
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as any).write = (chunk: any) => { outChunks.push(String(chunk)); return true; };
  (process.stderr as any).write = (chunk: any) => { errChunks.push(String(chunk)); return true; };
  try {
    await runCheckpointMark(["--vault", vaultDir, "--focus", "checkpoint 側の focus"]);
    const printed = JSON.parse(outChunks.join(""));
    assert.equal(printed.marker_path, checkpointMarkerPath(vaultDir));
    assert.equal(printed.ttl_minutes, CHECKPOINT_MARKER_TTL_MS / 60_000);
    assert.ok(Number.isFinite(Date.parse(printed.marked_at)));
    assert.match(errChunks.join(""), /checkpoint marker:/);

    const onDisk = JSON.parse(readFileSync(checkpointMarkerPath(vaultDir), "utf8"));
    assert.equal(onDisk.marked_at, printed.marked_at);
    assert.equal(onDisk.focus, "checkpoint 側の focus");
  } finally {
    (process.stdout as any).write = origOut;
    (process.stderr as any).write = origErr;
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCheckpointMark は vault 未指定で hard-error", async () => {
  const saved = process.env.GRAPHRAG_VAULT_DIR;
  delete process.env.GRAPHRAG_VAULT_DIR;
  try {
    await assert.rejects(() => runCheckpointMark([]), /requires a vault/);
  } finally {
    if (saved !== undefined) process.env.GRAPHRAG_VAULT_DIR = saved;
  }
});
