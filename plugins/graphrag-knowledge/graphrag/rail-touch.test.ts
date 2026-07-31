import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildVaultFiles } from "./build-vault.ts";
import { railTouch, reverseLookupFile } from "./rail-touch.ts";
import { loadRailSeen } from "./rail-common.ts";

// 合成 graph → 本物の vault ファイル経由 (constraint-check.test と同じ経路忠実主義)。
// vault は <root>/.graphrag/vault に置く — resolveRailCacheDir (cacheDirForVault) が
// vault 親の .graphrag/cache を導出する規則をそのまま踏む。
function makeVault(graph: Record<string, unknown>): { vaultDir: string; cacheDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "grag-rail-touch-"));
  const vaultDir = path.join(root, ".graphrag", "vault");
  for (const f of buildVaultFiles(graph as any)) {
    const abs = path.join(vaultDir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  return { vaultDir, cacheDir: path.join(root, ".graphrag", "cache") };
}

const GRAPH = {
  nodes: [
    { id: "file:s:src/pay.ts", type: "File", title: "pay", path: "src/pay.ts", summary: "決済" },
    { id: "file:s:src/free.ts", type: "File", title: "free", path: "src/free.ts", summary: "配線なし" },
    { id: "constraint:s:no-sync-io", type: "Constraint", title: "決済経路で同期 IO 禁止", summary: "落ちる検査あり" },
    { id: "decision:s:retry-policy", type: "Decision", title: "リトライは指数バックオフ", summary: "なぜそうしたか" },
    { id: "ok:s:gotcha", type: "OperationalKnowledge", title: "pay はタイムゾーンに罠がある", summary: "ハマり" }
  ],
  edges: [
    { id: "e1", type: "constrains", from: "constraint:s:no-sync-io", to: "file:s:src/pay.ts" },
    { id: "e2", type: "documented_by", from: "decision:s:retry-policy", to: "file:s:src/pay.ts" },
    { id: "e3", type: "documented_by", from: "ok:s:gotcha", to: "file:s:src/pay.ts" }
  ]
};

function withVault(graph: Record<string, unknown>, fn: (cacheDir: string) => void) {
  const { vaultDir, cacheDir } = makeVault(graph);
  const prev = process.env.GRAPHRAG_VAULT_DIR;
  process.env.GRAPHRAG_VAULT_DIR = vaultDir;
  try {
    fn(cacheDir);
  } finally {
    if (prev !== undefined) process.env.GRAPHRAG_VAULT_DIR = prev;
    else delete process.env.GRAPHRAG_VAULT_DIR;
  }
}

test("reverseLookupFile: 配線済み知識を Constraint 最優先で返す", () => {
  const items = reverseLookupFile(GRAPH, "src/pay.ts");
  assert.deepEqual(items.map((i) => i.type), ["Constraint", "Decision", "OperationalKnowledge"]);
  assert.equal(items[0].id, "constraint:s:no-sync-io");
});

test("reverseLookupFile: 配線ゼロのファイルは空", () => {
  assert.deepEqual(reverseLookupFile(GRAPH, "src/free.ts"), []);
});

test("railTouch: 配線ありで注入 + seen に記録、同一ファイル2回目は沈黙 (fast-path の裏付け)", () => {
  withVault(GRAPH, (cacheDir) => {
    const r1 = railTouch("src/pay.ts", "sessA");
    assert.equal(r1.status, "inject");
    assert.ok(r1.context!.includes("no-sync-io") || r1.context!.includes("同期 IO"), "Constraint が本文に出る");
    assert.ok(r1.chars! <= 700);

    const seen = loadRailSeen(cacheDir, "sessA");
    assert.ok(seen.touched_files.includes("src/pay.ts"));
    assert.ok(seen.injected_node_ids.includes("constraint:s:no-sync-io"));

    const r2 = railTouch("src/pay.ts", "sessA");
    assert.deepEqual(r2, { status: "silent", reason: "file-seen" });
  });
});

test("railTouch: 配線ゼロのファイルは沈黙するが touched には記録する (再走査抑止)", () => {
  withVault(GRAPH, (cacheDir) => {
    const r = railTouch("src/free.ts", "sessB");
    assert.equal(r.status, "silent");
    assert.equal(r.reason, "unwired");
    assert.ok(loadRailSeen(cacheDir, "sessB").touched_files.includes("src/free.ts"));
  });
});

test("railTouch: 別セッションは独立に注入される (並列セッションの誤抑制なし)", () => {
  withVault(GRAPH, () => {
    assert.equal(railTouch("src/pay.ts", "sessC").status, "inject");
    assert.equal(railTouch("src/pay.ts", "sessD").status, "inject");
  });
});

test("railTouch: rail-log.jsonl に発火が記録される", () => {
  withVault(GRAPH, (cacheDir) => {
    railTouch("src/pay.ts", "sessE");
    const log = path.join(cacheDir, "rail-log.jsonl");
    assert.ok(existsSync(log));
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const fired = lines.find((l) => l.rail === "touch" && l.fired === true);
    assert.ok(fired, "fired=true の行がある");
    assert.equal(fired.file, "src/pay.ts");
    assert.ok(typeof fired.chars === "number");
  });
});
