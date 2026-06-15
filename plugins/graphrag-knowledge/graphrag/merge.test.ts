import assert from "node:assert/strict";
import test from "node:test";
import { computeMergeDeltas } from "./merge.ts";

test("computeMergeDeltas returns empty deltas when nothing changed", () => {
  const graph = {
    nodes: [{ id: "decision:a", type: "Decision", title: "A" }],
    edges: []
  };
  const deltas = computeMergeDeltas(graph, graph, graph);
  assert.deepEqual(deltas.branchDelta.nodes, { added: [], removed: [], modified: [] });
  assert.deepEqual(deltas.mainDelta.nodes, { added: [], removed: [], modified: [] });
});

test("computeMergeDeltas captures only branch-side changes when main is untouched", () => {
  const base = {
    nodes: [{ id: "decision:a", type: "Decision", title: "A" }],
    edges: []
  };
  const branchNow = {
    nodes: [
      { id: "decision:a", type: "Decision", title: "A" },
      { id: "decision:b", type: "Decision", title: "B" }
    ],
    edges: []
  };
  const mainNow = base;

  const deltas = computeMergeDeltas(base, branchNow, mainNow);

  assert.deepEqual(deltas.branchDelta.nodes.added.map((n) => n.id), ["decision:b"]);
  assert.deepEqual(deltas.mainDelta.nodes.added, []);
});

test("computeMergeDeltas separates branch-side and main-side modifications of the same node", () => {
  const base = {
    nodes: [{ id: "decision:a", type: "Decision", title: "old" }],
    edges: []
  };
  const branchNow = {
    nodes: [{ id: "decision:a", type: "Decision", title: "branch title" }],
    edges: []
  };
  const mainNow = {
    nodes: [{ id: "decision:a", type: "Decision", title: "main title" }],
    edges: []
  };

  const deltas = computeMergeDeltas(base, branchNow, mainNow);

  assert.equal(deltas.branchDelta.nodes.modified.length, 1);
  assert.equal(deltas.mainDelta.nodes.modified.length, 1);
  assert.deepEqual(deltas.branchDelta.nodes.modified[0].propertyDiff, {
    title: { before: "old", after: "branch title" }
  });
  assert.deepEqual(deltas.mainDelta.nodes.modified[0].propertyDiff, {
    title: { before: "old", after: "main title" }
  });
});

test("computeMergeDeltas reports edges deltas independently per side", () => {
  const nodes = [
    { id: "system:test", type: "System" },
    { id: "decision:a", type: "Decision" },
    { id: "decision:b", type: "Decision" }
  ];
  const base = {
    nodes,
    edges: [
      { id: "edge:1", type: "contains", from: "system:test", to: "decision:a" }
    ]
  };
  const branchNow = {
    nodes,
    edges: [
      { id: "edge:1", type: "contains", from: "system:test", to: "decision:a" },
      { id: "edge:branch", type: "contains", from: "system:test", to: "decision:b" }
    ]
  };
  const mainNow = {
    nodes,
    edges: []
  };

  const deltas = computeMergeDeltas(base, branchNow, mainNow);

  assert.deepEqual(deltas.branchDelta.edges.added.map((e) => e.id), ["edge:branch"]);
  assert.deepEqual(deltas.mainDelta.edges.removed.map((e) => e.id), ["edge:1"]);
});
