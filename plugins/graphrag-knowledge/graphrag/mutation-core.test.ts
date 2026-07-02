import assert from "node:assert/strict";
import test from "node:test";
import { validateMutation, applyMutationToGraph, normalizeMutationPlan } from "./mutation-core.ts";

const baseGraph = () => ({
  nodes: [
    { id: "decision:s:a", type: "Decision", title: "A", summary: "a" },
    { id: "decision:s:b", type: "Decision", title: "B", summary: "b" },
  ],
  edges: [
    { id: "e1", type: "refines", from: "decision:s:a", to: "decision:s:b" },
  ],
});

test("付け替え: refines の to を b→a 以外へ更新すると next に反映", () => {
  const plan = { reason: "repoint", nodes: [], edges: [
    { op: "update", id: "e1", type: "refines", from: "decision:s:a", to: "decision:s:b" },
  ]};
  const v = validateMutation({ currentGraph: baseGraph(), plan });
  assert.equal(v.valid, true, v.failures.join("; "));
});

test("宙ぶらりんエッジを作る create は拒否", () => {
  const plan = { reason: "dangling", nodes: [], edges: [
    { op: "create", id: "e2", type: "refines", from: "decision:s:a", to: "decision:s:MISSING" },
  ]};
  const v = validateMutation({ currentGraph: baseGraph(), plan });
  assert.equal(v.valid, false);
  assert.ok(v.failures.some((f) => f.includes("missing to node")));
});

test("node 削除は DETACH カスケードで関連 edge を落とし audit に記録", () => {
  const plan = { reason: "del", nodes: [{ op: "delete", id: "decision:s:b" }], edges: [] };
  const v = validateMutation({ currentGraph: baseGraph(), plan });
  assert.equal(v.valid, true, v.failures.join("; "));
  assert.ok(!v.nextGraph.edges.some((e) => e.id === "e1"), "e1 should cascade");
  assert.deepEqual(v.cascadedEdgeIds, ["e1"]);
});

test("duplicate_ack は正規化後の plan に保持され、未指定は空配列", () => {
  const node = { op: "create", id: "decision:s:c", type: "Decision", title: "C" };
  const withAck = normalizeMutationPlan({
    reason: "r",
    nodes: [node],
    edges: [],
    duplicate_ack: ["decision:s:a", "decision:s:b"],
  });
  assert.deepEqual(withAck.duplicate_ack, ["decision:s:a", "decision:s:b"]);
  const withoutAck = normalizeMutationPlan({ reason: "r", nodes: [node], edges: [] });
  assert.deepEqual(withoutAck.duplicate_ack, []);
});

test("duplicate_ack が文字列配列でなければ明示エラー (黙って落として reject させない)", () => {
  const node = { op: "create", id: "decision:s:c", type: "Decision", title: "C" };
  assert.throws(
    () => normalizeMutationPlan({ nodes: [node], edges: [], duplicate_ack: "decision:s:a" }),
    /duplicate_ack/
  );
  assert.throws(
    () => normalizeMutationPlan({ nodes: [node], edges: [], duplicate_ack: [1, 2] }),
    /duplicate_ack/
  );
});

test("updates の null はフィールド削除を意味する (state 取り下げで frontmatter に null を残さない)", () => {
  const graph = {
    nodes: [{ id: "decision:s:a", type: "Decision", title: "A", state: "superseded", summary: "s" }],
    edges: []
  };
  const plan = normalizeMutationPlan({
    reason: "r",
    nodes: [{ op: "update", id: "decision:s:a", updates: { state: null } }],
    edges: []
  });
  const next = applyMutationToGraph(graph, plan);
  const node = next.nodes.find((n) => n.id === "decision:s:a");
  assert.ok(!("state" in node), "state キー自体が消えること (null 残置は不可)");
  assert.equal(node.summary, "s", "他フィールドは保持");
});

test("update が触らない既存 null フィールドも merge 時に掃除される", () => {
  const graph = {
    nodes: [{ id: "decision:s:a", type: "Decision", title: "A", state: null }],
    edges: []
  };
  const plan = normalizeMutationPlan({
    reason: "r",
    nodes: [{ op: "update", id: "decision:s:a", updates: { summary: "new" } }],
    edges: []
  });
  const next = applyMutationToGraph(graph, plan);
  const node = next.nodes.find((n) => n.id === "decision:s:a");
  assert.ok(!("state" in node), "legacy の state:null は触ったノードから掃除される");
  assert.equal(node.summary, "new");
});

test("create に null フィールドがあればキーごと落とす", () => {
  const plan = normalizeMutationPlan({
    reason: "r",
    nodes: [{ op: "create", id: "decision:s:b", type: "Decision", title: "B", state: null }],
    edges: []
  });
  const next = applyMutationToGraph({ nodes: [], edges: [] }, plan);
  const node = next.nodes.find((n) => n.id === "decision:s:b");
  assert.ok(!("state" in node));
});

// ── op:update の generated_at 更新 (staleness 収束) ──────────────────────────

test("op:update は generated_at を now に進める (再検証の刻印。staleness の起点が進む)", () => {
  const graph = {
    nodes: [
      { id: "n1", type: "Decision", title: "T", generated_at: "2020-01-01T00:00:00.000Z" },
      { id: "n2", type: "Decision", title: "U", generated_at: "2020-01-01T00:00:00.000Z" },
    ],
    edges: [],
  };
  const plan = normalizeMutationPlan({
    nodes: [{ op: "update", id: "n1", updates: { summary: "re-verified" } }],
  });
  const before = Date.now() - 1000;
  const next = applyMutationToGraph(graph, plan);
  const updated = next.nodes.find((n) => n.id === "n1");
  assert.notEqual(updated.generated_at, "2020-01-01T00:00:00.000Z");
  assert.ok(Date.parse(updated.generated_at) >= before, "now に更新される");
  // 触っていないノードは据え置き (unrelated files must not churn)
  const untouched = next.nodes.find((n) => n.id === "n2");
  assert.equal(untouched.generated_at, "2020-01-01T00:00:00.000Z");
});

test("op:update で plan が generated_at を明示した場合はそれを尊重する", () => {
  const graph = {
    nodes: [{ id: "n1", type: "Decision", title: "T", generated_at: "2020-01-01T00:00:00.000Z" }],
    edges: [],
  };
  const plan = normalizeMutationPlan({
    nodes: [{ op: "update", id: "n1", updates: { generated_at: "2024-06-01T00:00:00.000Z" } }],
  });
  const next = applyMutationToGraph(graph, plan);
  assert.equal(next.nodes[0].generated_at, "2024-06-01T00:00:00.000Z");
});
