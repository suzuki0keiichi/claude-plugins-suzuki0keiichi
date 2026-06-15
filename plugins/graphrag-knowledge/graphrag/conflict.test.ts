import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyConflictZone,
  classifyConflictZones,
  detectStructuralConflicts,
  type ConflictZone
} from "./conflict.ts";
import { computeMergeDeltas } from "./merge.ts";

test("detectStructuralConflicts flags nodes modified on both sides", () => {
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

  const conflicts = detectStructuralConflicts(computeMergeDeltas(base, branchNow, mainNow));

  const byId = conflicts.filter((c) => c.signal === "node_co_modified");
  assert.equal(byId.length, 1);
  assert.equal(byId[0].nodeId, "decision:a");
});

test("detectStructuralConflicts ignores nodes modified on only one side", () => {
  const base = {
    nodes: [{ id: "decision:a", type: "Decision", title: "old" }],
    edges: []
  };
  const branchNow = {
    nodes: [{ id: "decision:a", type: "Decision", title: "branch title" }],
    edges: []
  };
  const mainNow = base;

  const conflicts = detectStructuralConflicts(computeMergeDeltas(base, branchNow, mainNow));
  assert.equal(conflicts.filter((c) => c.signal === "node_co_modified").length, 0);
});

test("detectStructuralConflicts flags policy edges that target the same node from both sides", () => {
  const nodes = [
    { id: "decision:a", type: "Decision" },
    { id: "decision:branch", type: "Decision" },
    { id: "decision:main", type: "Decision" },
    { id: "decision:target", type: "Decision" }
  ];
  const base = { nodes, edges: [] };
  const branchNow = {
    nodes,
    edges: [
      {
        id: "edge:branch",
        type: "has_premise",
        from: "decision:branch",
        to: "decision:target"
      }
    ]
  };
  const mainNow = {
    nodes,
    edges: [
      {
        id: "edge:main",
        type: "has_premise",
        from: "decision:main",
        to: "decision:target"
      }
    ]
  };

  const conflicts = detectStructuralConflicts(computeMergeDeltas(base, branchNow, mainNow));
  const policy = conflicts.filter((c) => c.signal === "edge_target_co_added");
  assert.equal(policy.length, 1);
  assert.equal(policy[0].target, "decision:target");
  assert.equal(policy[0].edgeType, "has_premise");
});

test("detectStructuralConflicts ignores edge target collisions for non-policy relations", () => {
  const nodes = [
    { id: "system:test", type: "System" },
    { id: "decision:target", type: "Decision" }
  ];
  const base = { nodes, edges: [] };
  const branchNow = {
    nodes,
    edges: [
      { id: "edge:b", type: "contains", from: "system:test", to: "decision:target" }
    ]
  };
  const mainNow = {
    nodes,
    edges: [
      { id: "edge:m", type: "contains", from: "system:test", to: "decision:target" }
    ]
  };
  const conflicts = detectStructuralConflicts(computeMergeDeltas(base, branchNow, mainNow));
  assert.equal(conflicts.filter((c) => c.signal === "edge_target_co_added").length, 0);
});

test("detectStructuralConflicts flags newly added Decisions without supersedes or refines", () => {
  const base = { nodes: [], edges: [] };
  const branchNow = {
    nodes: [{ id: "decision:new-branch", type: "Decision", title: "new from branch" }],
    edges: []
  };
  const mainNow = {
    nodes: [{ id: "decision:new-main", type: "Decision", title: "new from main" }],
    edges: []
  };

  const conflicts = detectStructuralConflicts(computeMergeDeltas(base, branchNow, mainNow));
  const lineageMissing = conflicts.filter((c) => c.signal === "decision_without_lineage");
  assert.equal(lineageMissing.length, 2);
  const ids = lineageMissing.map((c) => c.nodeId).sort();
  assert.deepEqual(ids, ["decision:new-branch", "decision:new-main"]);
});

test("detectStructuralConflicts flags vector-similar newly added Decisions", () => {
  const base = { nodes: [], edges: [] };
  const branchNow = {
    nodes: [{ id: "decision:new-branch", type: "Decision", title: "branch new" }],
    edges: []
  };
  const mainNow = {
    nodes: [{ id: "decision:new-main", type: "Decision", title: "main new" }],
    edges: []
  };

  const conflicts = detectStructuralConflicts(computeMergeDeltas(base, branchNow, mainNow), {
    vectorSimilarityThreshold: 0.9,
    vectorIndex: {
      rows: [
        { node_id: "decision:new-branch", vector: [1, 0] },
        { node_id: "decision:new-main", vector: [0.95, 0.05] }
      ]
    }
  });

  const vectorSimilar = conflicts.filter((c) => c.signal === "decision_vector_similar");
  assert.equal(vectorSimilar.length, 1);
  assert.equal(vectorSimilar[0].branchNodeId, "decision:new-branch");
  assert.equal(vectorSimilar[0].mainNodeId, "decision:new-main");
});

test("detectStructuralConflicts skips Decisions that ship with supersedes lineage", () => {
  const base = {
    nodes: [{ id: "rejected:old", type: "RejectedOption" }],
    edges: []
  };
  const branchNow = {
    nodes: [
      { id: "rejected:old", type: "RejectedOption" },
      { id: "decision:new-branch", type: "Decision", title: "branch new" }
    ],
    edges: [
      {
        id: "edge:supersede",
        type: "supersedes",
        from: "decision:new-branch",
        to: "rejected:old"
      }
    ]
  };
  const mainNow = base;

  const conflicts = detectStructuralConflicts(computeMergeDeltas(base, branchNow, mainNow));
  assert.equal(conflicts.filter((c) => c.signal === "decision_without_lineage").length, 0);
});

test("detectStructuralConflicts only inspects newly added Decision nodes for lineage", () => {
  const base = {
    nodes: [{ id: "decision:existing", type: "Decision" }],
    edges: []
  };
  const branchNow = base;
  const mainNow = base;
  const conflicts = detectStructuralConflicts(computeMergeDeltas(base, branchNow, mainNow));
  assert.equal(conflicts.filter((c) => c.signal === "decision_without_lineage").length, 0);
});

test("classifyConflictZone marks node_co_modified as semantic when both sides touch the same property", () => {
  const zone: ConflictZone = {
    signal: "node_co_modified",
    nodeId: "decision:a",
    branchSide: {
      before: { id: "decision:a", type: "Decision", title: "old" },
      after: { id: "decision:a", type: "Decision", title: "branch" },
      propertyDiff: { title: { before: "old", after: "branch" } }
    },
    mainSide: {
      before: { id: "decision:a", type: "Decision", title: "old" },
      after: { id: "decision:a", type: "Decision", title: "main" },
      propertyDiff: { title: { before: "old", after: "main" } }
    }
  };
  assert.equal(classifyConflictZone(zone), "semantic");
});

test("classifyConflictZone marks node_co_modified as mechanical when sides touch disjoint properties", () => {
  const zone: ConflictZone = {
    signal: "node_co_modified",
    nodeId: "decision:a",
    branchSide: {
      before: { id: "decision:a", type: "Decision", title: "x", state: "accepted" },
      after: { id: "decision:a", type: "Decision", title: "x", state: "superseded" },
      propertyDiff: { state: { before: "accepted", after: "superseded" } }
    },
    mainSide: {
      before: { id: "decision:a", type: "Decision", title: "x", state: "accepted" },
      after: { id: "decision:a", type: "Decision", title: "x", state: "accepted", note: "ok" },
      propertyDiff: { note: { before: undefined, after: "ok" } }
    }
  };
  assert.equal(classifyConflictZone(zone), "mechanical");
});

test("classifyConflictZone marks edge_target_co_added as mechanical", () => {
  const zone: ConflictZone = {
    signal: "edge_target_co_added",
    edgeType: "has_premise",
    target: "decision:target",
    branchEdges: [
      { id: "edge:b", type: "has_premise", from: "decision:branch", to: "decision:target" }
    ],
    mainEdges: [
      { id: "edge:m", type: "has_premise", from: "decision:main", to: "decision:target" }
    ]
  };
  assert.equal(classifyConflictZone(zone), "mechanical");
});

test("classifyConflictZone marks decision_without_lineage as semantic", () => {
  const zone: ConflictZone = {
    signal: "decision_without_lineage",
    nodeId: "decision:new",
    side: "branch"
  };
  assert.equal(classifyConflictZone(zone), "semantic");
});

test("classifyConflictZone marks decision_vector_similar as semantic", () => {
  const zone: ConflictZone = {
    signal: "decision_vector_similar",
    branchNodeId: "decision:branch",
    mainNodeId: "decision:main",
    similarity: 0.93,
    threshold: 0.9,
    branchNode: { id: "decision:branch", type: "Decision" },
    mainNode: { id: "decision:main", type: "Decision" }
  };
  assert.equal(classifyConflictZone(zone), "semantic");
});

test("classifyConflictZones preserves zone shape and adds resolution label", () => {
  const zones: ConflictZone[] = [
    { signal: "decision_without_lineage", nodeId: "decision:a", side: "branch" }
  ];
  const classified = classifyConflictZones(zones);
  assert.equal(classified.length, 1);
  assert.equal(classified[0].resolution, "semantic");
  assert.equal(classified[0].signal, "decision_without_lineage");
});
