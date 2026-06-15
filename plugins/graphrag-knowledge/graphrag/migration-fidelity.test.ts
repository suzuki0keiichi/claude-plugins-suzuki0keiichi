import assert from "node:assert/strict";
import test from "node:test";
import { autoQueriesFromGraph, searchRecallLoss, runFidelityCheck } from "./migration-fidelity.ts";

function fakeProvider(dim = 3) {
  return {
    id: "fake", capability: "semantic", semantic: true, dimensions: dim,
    metadata: { endpoint: "x", model: "y" },
    embed: async (t: string) => { const v = new Array(dim).fill(0); v[0] = t.length % 5; v[1] = 1; return v; }
  };
}

test("autoQueriesFromGraph derives one query per node title (deduped, non-empty)", () => {
  const g = { nodes: [
    { id: "a", type: "Decision", title: "認証基盤" },
    { id: "b", type: "Vein", title: "認証基盤" }, // 重複 title
    { id: "c", type: "File", title: "" }          // 空は除外
  ], edges: [] };
  const qs = autoQueriesFromGraph(g);
  assert.deepEqual([...new Set(qs)], qs, "重複なし");
  assert.ok(qs.includes("認証基盤"));
  assert.ok(!qs.includes(""));
});

test("searchRecallLoss reports nodes retrievable before but not after", () => {
  const before = { nodes: [
    { id: "a", type: "Decision", title: "認証基盤" },
    { id: "b", type: "Decision", title: "課金" }
  ], edges: [] };
  // after で "課金" ノードが欠落 → recall loss
  const after = { nodes: [{ id: "a", type: "Decision", title: "認証基盤" }], edges: [] };
  const queries = ["認証基盤", "課金"];
  const loss = searchRecallLoss(before, after, queries, { limit: 5 });
  assert.ok(loss.some((l) => l.includes("b")), loss.join("; "));
  // 完全一致 (after=before) なら取りこぼしゼロ
  assert.deepEqual(searchRecallLoss(before, before, queries, { limit: 5 }), []);
});

test("runFidelityCheck: clean v2 graph migrates with zero structure loss and zero recall loss", async () => {
  const v2 = { generated_at: "2026-05-29T00:00:00.000Z", nodes: [
    { id: "system:acme", type: "System", title: "Acme" },
    { id: "concern:acme:auth", type: "Concern", title: "認証基盤", summary: "s" },
    { id: "decision:acme:x", type: "Decision", title: "shard 採用" }
  ], edges: [
    { id: "e1", type: "contains", from: "system:acme", to: "concern:acme:auth" }
  ] };
  const r = await runFidelityCheck(v2, { provider: fakeProvider(3) });
  assert.deepEqual(r.structureLoss, [], r.structureLoss.join("; "));
  assert.deepEqual(r.recallLoss, [], r.recallLoss.join("; "));
});

test("runFidelityCheck works without a provider (structure + lexical recall only)", async () => {
  const v2 = { nodes: [
    { id: "concern:acme:auth", type: "Concern", title: "認証基盤" }
  ], edges: [] };
  const r = await runFidelityCheck(v2, {});
  assert.deepEqual(r.structureLoss, []);
  assert.deepEqual(r.recallLoss, []);
});

import { compareAcrossMigration } from "./migration-fidelity.ts";

test("compareAcrossMigration detects a field dropped by migration (canonical type/id allowed)", () => {
  const v2 = { nodes: [
    { id: "concern:acme:auth", type: "Concern", title: "認証", summary: "横断関心" }
  ], edges: [] };
  // after: type/id は正しく canonical 化されているが summary が脱落
  const afterMissing = { nodes: [
    { id: "vein:acme:auth", type: "Vein", title: "認証" }
  ], edges: [] };
  const loss = compareAcrossMigration(v2, afterMissing);
  assert.ok(loss.some((l) => l.includes("summary")), loss.join("; "));

  // 正しい canonical 化 (全フィールド保存) なら劣化ゼロ
  const afterOk = { nodes: [
    { id: "vein:acme:auth", type: "Vein", title: "認証", summary: "横断関心" }
  ], edges: [] };
  assert.deepEqual(compareAcrossMigration(v2, afterOk), []);
});

test("runFidelityCheck detects field loss end-to-end is impossible to fake here, but clean graph passes (v2 baseline)", async () => {
  const v2 = { nodes: [
    { id: "concern:acme:auth", type: "Concern", title: "認証基盤", summary: "s", aliases: ["ログイン"] }
  ], edges: [] };
  const r = await runFidelityCheck(v2, { provider: fakeProvider(3) });
  assert.deepEqual(r.structureLoss, [], r.structureLoss.join("; "));
  assert.deepEqual(r.recallLoss, [], r.recallLoss.join("; "));
  // v2 を基準にしているので、戻り値も v2 を保持
  assert.equal(r.v2.nodes[0].id, "concern:acme:auth");
  assert.equal(r.after.nodes[0].id, "vein:acme:auth");
});

test("runFidelityCheck recognizes semantic overrides as intentional (no false loss)", async () => {
  const v2 = { nodes: [
    { id: "requirement:s:x", type: "Requirement", title: "要件X", summary: "s" },
    { id: "decision:s:d", type: "Decision", title: "決定D" },
    { id: "conversation:s:c", type: "ConversationChunk", title: "会話メモ" }
  ], edges: [
    { id: "e1", type: "constrained_by", from: "requirement:s:x", to: "decision:s:d" },
    { id: "e2", type: "derived_from", from: "requirement:s:x", to: "conversation:s:c" }
  ] };
  const overrides = {
    nodeOverrides: { "requirement:s:x": { type: "Goal", id: "goal:s:x" } },
    edgeOverrides: { "e1": { type: "has_premise", from: "decision:s:d", to: "goal:s:x" } }
  };
  const r = await runFidelityCheck(v2, { provider: fakeProvider(3), overrides });
  // 意味変換は意図的なので劣化ゼロ
  assert.deepEqual(r.structureLoss, [], r.structureLoss.join("; "));
  assert.deepEqual(r.recallLoss, [], r.recallLoss.join("; "));
  // after では goal:s:x になっている
  assert.ok(r.after.nodes.some((n) => n.id === "goal:s:x" && n.type === "Goal"));
});
