// stocktake verb (Investigation ライフサイクル棚卸しの機械検出) の単体テスト。
// 実行: node --experimental-strip-types --test graphrag/stocktake.test.ts
//
// 検出ロジックは純関数 stocktake(graph, {now}) に now を注入して決定論的に検証する。
// vault 経由 (loadGraph) の疎通と hard-error は makeVault + runStocktake で確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildVaultFiles } from "./build-vault.ts";
import { stocktake, runStocktake } from "./stocktake.ts";

// 固定の「今」。stale 判定は now を基準にするので注入して決定論化する。
const NOW = Date.parse("2026-07-08T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

function run(nodes: any[], opts: { staleDays?: number } = {}) {
  return stocktake({ nodes }, { vaultDir: "/x", staleDays: opts.staleDays ?? 14, now: NOW });
}

// checkpoint-marker.test.ts の makeVault の流儀を踏襲した一時 vault。
function makeVault(nodes: any[]): { root: string; vaultDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "stk-"));
  const vaultDir = path.join(root, ".graphrag", "vault");
  for (const f of buildVaultFiles({ generated_at: iso(NOW), nodes, edges: [] })) {
    const abs = path.join(vaultDir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  return { root, vaultDir };
}

async function runCaptured(argv: string[]): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (chunk: any) => { chunks.push(String(chunk)); return true; };
  try {
    await runStocktake(argv);
  } finally {
    (process.stdout as any).write = orig;
  }
  return chunks.join("");
}

// --- stateless 検出 ---

test("stateless: state 無し Investigation を検出する", () => {
  const r = run([{ id: "investigation:s:old", type: "Investigation", title: "旧調査" }]);
  assert.equal(r.suspects.length, 1);
  assert.equal(r.suspects[0].id, "investigation:s:old");
  assert.equal(r.suspects[0].state, null);
  assert.deepEqual(r.suspects[0].signals, ["stateless"]);
  assert.equal(r.counts.stateless, 1);
});

// --- stale-active 検出 ---

test("stale-active: 閾値より古い active を検出する", () => {
  const r = run([
    { id: "investigation:s:stale", type: "Investigation", title: "放置", state: "active",
      generated_at: iso(NOW - 20 * DAY) }
  ]);
  assert.equal(r.suspects.length, 1);
  assert.equal(r.suspects[0].state, "active");
  assert.deepEqual(r.suspects[0].signals, ["stale-active"]);
});

test("新鮮な active は suspect でない", () => {
  const r = run([
    { id: "investigation:s:fresh", type: "Investigation", title: "現役", state: "active",
      generated_at: iso(NOW - 2 * DAY) }
  ]);
  assert.equal(r.suspects.length, 0);
  assert.equal(r.counts.active, 1);
  assert.match(r.next_action_hint, /healthy/);
});

test("generated_at 欠損の active は stale-active + no-generated-at", () => {
  const r = run([{ id: "investigation:s:nogen", type: "Investigation", title: "日時無し", state: "active" }]);
  assert.equal(r.suspects.length, 1);
  assert.deepEqual(r.suspects[0].signals, ["stale-active", "no-generated-at"]);
  assert.equal(r.suspects[0].generated_at, null);
});

// --- closed は対象外 ---

test("closed は progress マーカー持ちでも suspect でない", () => {
  const r = run([
    { id: "investigation:s:done", type: "Investigation", title: "WIP のまま終結", state: "closed",
      summary: "未実装だったが方針転換で closed", generated_at: iso(NOW - 100 * DAY) }
  ]);
  assert.equal(r.suspects.length, 0);
  assert.equal(r.counts.investigations, 1);
  assert.equal(r.counts.active, 0);
});

// --- progress-claim ---

test("progress-claim: title・summary で効き、raw_content では効かない", () => {
  const r = run([
    // title に「進行中」
    { id: "investigation:s:a", type: "Investigation", title: "認証まわり進行中", state: "active",
      generated_at: iso(NOW - 1 * DAY) },
    // summary に「未実装」
    { id: "investigation:s:b", type: "Investigation", title: "b", state: "active",
      summary: "キャッシュ層は未実装", generated_at: iso(NOW - 1 * DAY) },
    // raw_content にだけマーカー — 誤検知しないこと (作業メモの「途中」等を拾わない)
    { id: "investigation:s:c", type: "Investigation", title: "c", state: "active",
      raw_content: "current focus: 未実装の部分を洗い出し中\nnext: x", generated_at: iso(NOW - 1 * DAY) }
  ]);
  const ids = r.suspects.map((s) => s.id);
  assert.ok(ids.includes("investigation:s:a"));
  assert.ok(ids.includes("investigation:s:b"));
  assert.ok(!ids.includes("investigation:s:c"), "raw_content のマーカーは拾わない");

  const a = r.suspects.find((s) => s.id === "investigation:s:a");
  assert.deepEqual(a?.signals, ["progress-claim"]);
  assert.deepEqual(a?.progress_markers, ["進行中"]);
  const b = r.suspects.find((s) => s.id === "investigation:s:b");
  assert.deepEqual(b?.progress_markers, ["未実装"]);
});

test("stateless かつ progress マーカーは signals 2 件で先頭に来る", () => {
  const r = run([
    { id: "investigation:s:single", type: "Investigation", title: "現役", state: "active",
      generated_at: iso(NOW - 1 * DAY), summary: "WIP" }, // progress-claim のみ (1 signal)
    { id: "investigation:s:double", type: "Investigation", title: "旧 WIP", summary: "in progress" } // stateless + progress-claim (2)
  ]);
  // signals 数の多い順 → double が先頭
  assert.equal(r.suspects[0].id, "investigation:s:double");
  assert.deepEqual(r.suspects[0].signals, ["stateless", "progress-claim"]);
});

// --- --days 反映 ---

test("--days (staleDays) 閾値を反映する", () => {
  const nodes = [
    { id: "investigation:s:x", type: "Investigation", title: "10日前", state: "active",
      generated_at: iso(NOW - 10 * DAY) }
  ];
  // 既定 14 日なら stale でない
  assert.equal(run(nodes, { staleDays: 14 }).suspects.length, 0);
  // 5 日閾値なら stale
  const strict = run(nodes, { staleDays: 5 });
  assert.equal(strict.suspects.length, 1);
  assert.deepEqual(strict.suspects[0].signals, ["stale-active"]);
  assert.equal(strict.thresholds.stale_days, 5);
});

// --- counts 整合 ---

test("counts が投入ノードと整合する", () => {
  const r = run([
    { id: "investigation:s:a", type: "Investigation", title: "現役新鮮", state: "active",
      generated_at: iso(NOW - 1 * DAY) },
    { id: "investigation:s:b", type: "Investigation", title: "現役古い", state: "active",
      generated_at: iso(NOW - 30 * DAY) },
    { id: "investigation:s:c", type: "Investigation", title: "旧" }, // stateless
    { id: "investigation:s:d", type: "Investigation", title: "終結", state: "closed" },
    { id: "decision:s:x", type: "Decision", title: "無関係" } // Investigation 以外は数えない
  ]);
  assert.equal(r.counts.investigations, 4);
  assert.equal(r.counts.active, 2);
  assert.equal(r.counts.stateless, 1);
  // suspects = b (stale-active) + c (stateless)
  assert.equal(r.counts.suspects, 2);
});

// --- vault 経由 (loadGraph) の疎通 ---

test("runStocktake: vault から読み JSON を stdout に出す (書き込みなし)", async () => {
  const { root, vaultDir } = makeVault([
    { id: "investigation:s:old", type: "Investigation", title: "旧調査" }
  ]);
  try {
    const out = await runCaptured(["--vault", vaultDir]);
    const printed = JSON.parse(out);
    assert.equal(printed.generated_by, "graphrag/stocktake.ts");
    assert.equal(printed.vault_dir, vaultDir);
    assert.equal(printed.counts.investigations, 1);
    assert.equal(printed.counts.stateless, 1);
    assert.equal(printed.suspects.length, 1);
    assert.match(printed.next_action_hint, /graphrag-stocktake skill/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- vault 未指定 hard-error ---

test("vault 未指定で hard-error", async () => {
  const saved = process.env.GRAPHRAG_VAULT_DIR;
  delete process.env.GRAPHRAG_VAULT_DIR;
  try {
    await assert.rejects(() => runStocktake([]), /requires a vault/);
  } finally {
    if (saved !== undefined) process.env.GRAPHRAG_VAULT_DIR = saved;
  }
});
