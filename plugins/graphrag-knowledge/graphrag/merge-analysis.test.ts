import assert from "node:assert/strict";
import test from "node:test";
import { analyzeMerge, projectNodeForJudgment } from "./merge-analysis.ts";

test("analyzeMerge reports no conflicts when nothing changed", () => {
  const g = { nodes: [{ id: "decision:a", type: "Decision", title: "A" }], edges: [] };
  const a = analyzeMerge(g, g, g);
  assert.equal(a.conflicts.length, 0);
  assert.equal(a.hasSemanticConflicts, false);
  assert.deepEqual(a.summary.conflicts, { total: 0, mechanical: 0, semantic: 0 });
});

test("analyzeMerge: a non-Decision branch-only addition is no conflict", () => {
  const base = { nodes: [{ id: "decision:a", type: "Decision" }], edges: [] };
  const branchNow = {
    nodes: [{ id: "decision:a", type: "Decision" }, { id: "risk:b", type: "Risk" }],
    edges: []
  };
  const a = analyzeMerge(base, branchNow, base);
  assert.equal(a.summary.branch.nodesAdded, 1);
  assert.equal(a.conflicts.length, 0);
});

test("analyzeMerge: a new Decision without lineage is intentionally flagged for judgment", () => {
  // Even a branch-only addition gets flagged when it is a Decision with no
  // supersedes/refines edge — it might duplicate or silently replace existing
  // knowledge, so it needs meaning-level review rather than a silent merge.
  const base = { nodes: [], edges: [] };
  const branchNow = { nodes: [{ id: "decision:new", type: "Decision", title: "x" }], edges: [] };
  const a = analyzeMerge(base, branchNow, base);
  assert.equal(a.hasSemanticConflicts, true);
  assert.ok(a.semanticConflicts.some((zone) => zone.signal === "decision_without_lineage"));
});

test("analyzeMerge: both sides editing the same property is a semantic conflict", () => {
  const base = { nodes: [{ id: "decision:a", type: "Decision", title: "old" }], edges: [] };
  const branchNow = { nodes: [{ id: "decision:a", type: "Decision", title: "branch" }], edges: [] };
  const mainNow = { nodes: [{ id: "decision:a", type: "Decision", title: "main" }], edges: [] };
  const a = analyzeMerge(base, branchNow, mainNow);
  assert.equal(a.hasSemanticConflicts, true);
  assert.equal(a.semanticConflicts.length, 1);
  assert.equal(a.semanticConflicts[0].signal, "node_co_modified");
});

test("analyzeMerge: same-target policy edges from both sides is a mechanical conflict", () => {
  const nodes = [
    { id: "decision:branch", type: "Decision" },
    { id: "decision:main", type: "Decision" },
    { id: "decision:target", type: "Decision" }
  ];
  const base = { nodes, edges: [] };
  const branchNow = { nodes, edges: [{ id: "e:b", type: "has_premise", from: "decision:branch", to: "decision:target" }] };
  const mainNow = { nodes, edges: [{ id: "e:m", type: "has_premise", from: "decision:main", to: "decision:target" }] };
  const a = analyzeMerge(base, branchNow, mainNow);
  assert.equal(a.summary.conflicts.mechanical, 1);
  assert.equal(a.hasSemanticConflicts, false);
});

test("analyzeMerge: vector-similar new Decisions are flagged semantic", () => {
  const base = { nodes: [], edges: [] };
  const branchNow = { nodes: [{ id: "decision:nb", type: "Decision", title: "b" }], edges: [] };
  const mainNow = { nodes: [{ id: "decision:nm", type: "Decision", title: "m" }], edges: [] };
  const a = analyzeMerge(base, branchNow, mainNow, {
    vectorSimilarityThreshold: 0.9,
    vectorIndex: {
      rows: [
        { node_id: "decision:nb", vector: [1, 0] },
        { node_id: "decision:nm", vector: [0.95, 0.05] }
      ]
    }
  });
  assert.ok(a.semanticConflicts.some((zone) => zone.signal === "decision_vector_similar"));
  assert.equal(a.hasSemanticConflicts, true);
});

test("projectNodeForJudgment keeps distilled fields and drops noise (generated_at / raw_content)", () => {
  const node = {
    id: "decision:a",
    type: "Decision",
    title: "T",
    summary: "S",
    state: "accepted",
    generated_at: "2026-01-01T00:00:00Z",
    raw_content: "...long source text..."
  };
  assert.deepEqual(projectNodeForJudgment(node), {
    id: "decision:a",
    type: "Decision",
    title: "T",
    summary: "S",
    state: "accepted"
  });
});
