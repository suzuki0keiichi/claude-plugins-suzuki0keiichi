import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateGraph } from "./schema.ts";
import { getPreset } from "./schema-registry.ts";

const S = getPreset("project")!;

describe("project schema preset", () => {
  it("is registered and resolvable", () => {
    assert.ok(S);
    assert.strictEqual(S.id, "project");
  });

  it("has 16 node types (no Deliverable — lives in system vault)", () => {
    assert.strictEqual(S.nodeTypes.length, 16);
    assert.ok(!S.nodeTypes.includes("Deliverable"));
    assert.ok(!S.nodeTypes.includes("File"));
    assert.ok(S.nodeTypes.includes("Source"));
    assert.ok(S.nodeTypes.includes("Theme"));
    assert.ok(S.nodeTypes.includes("Stakeholder"));
    assert.ok(S.nodeTypes.includes("Task"));
    assert.ok(S.nodeTypes.includes("Agreement"));
    assert.ok(S.nodeTypes.includes("Milestone"));
    assert.ok(S.nodeTypes.includes("Assumption"));
    assert.ok(S.nodeTypes.includes("Resource"));
  });

  it("Agreement state vocabulary: exploring→negotiating→signed→active→expired", () => {
    assert.deepStrictEqual(S.stateVocabulary["Agreement"], [
      "exploring", "negotiating", "signed", "active", "expired"
    ]);
  });

  it("Task state vocabulary: planned→active→completed→cancelled", () => {
    assert.deepStrictEqual(S.stateVocabulary["Task"], [
      "planned", "active", "completed", "cancelled"
    ]);
  });

  it("Milestone state vocabulary: planned→achieved→missed", () => {
    assert.deepStrictEqual(S.stateVocabulary["Milestone"], [
      "planned", "achieved", "missed"
    ]);
  });

  it("Risk has NO state (expressed via edges)", () => {
    assert.strictEqual(S.stateVocabulary["Risk"], undefined);
  });

  it("Assumption has NO state (certainty level is a separate axis)", () => {
    assert.strictEqual(S.stateVocabulary["Assumption"], undefined);
  });

  it("achieves: Task → Goal", () => {
    const g = {
      nodes: [
        { id: "task:p:a", type: "Task" },
        { id: "goal:p:b", type: "Goal" },
      ],
      edges: [{ id: "e1", type: "achieves", from: "task:p:a", to: "goal:p:b" }],
    };
    assert.deepStrictEqual(validateGraph(g, S), []);
  });

  it("depends_on: Task → Task", () => {
    const g = {
      nodes: [
        { id: "task:p:a", type: "Task" },
        { id: "task:p:b", type: "Task" },
      ],
      edges: [{ id: "e1", type: "depends_on", from: "task:p:a", to: "task:p:b" }],
    };
    assert.deepStrictEqual(validateGraph(g, S), []);
  });

  it("falls_back_to: Goal → Goal (PlanB)", () => {
    const g = {
      nodes: [
        { id: "goal:p:a", type: "Goal" },
        { id: "goal:p:b", type: "Goal" },
      ],
      edges: [{ id: "e1", type: "falls_back_to", from: "goal:p:a", to: "goal:p:b" }],
    };
    assert.deepStrictEqual(validateGraph(g, S), []);
  });

  it("requires: Task → Resource", () => {
    const g = {
      nodes: [
        { id: "task:p:a", type: "Task" },
        { id: "resource:p:b", type: "Resource" },
      ],
      edges: [{ id: "e1", type: "requires", from: "task:p:a", to: "resource:p:b" }],
    };
    assert.deepStrictEqual(validateGraph(g, S), []);
  });

  it("party_to: Stakeholder → Agreement", () => {
    const g = {
      nodes: [
        { id: "stakeholder:p:a", type: "Stakeholder" },
        { id: "agreement:p:b", type: "Agreement" },
      ],
      edges: [{ id: "e1", type: "party_to", from: "stakeholder:p:a", to: "agreement:p:b" }],
    };
    assert.deepStrictEqual(validateGraph(g, S), []);
  });

  it("risks_in: Risk → Task/Goal/Milestone", () => {
    const g = {
      nodes: [
        { id: "risk:p:a", type: "Risk" },
        { id: "task:p:b", type: "Task" },
        { id: "goal:p:c", type: "Goal" },
        { id: "milestone:p:d", type: "Milestone" },
      ],
      edges: [
        { id: "e1", type: "risks_in", from: "risk:p:a", to: "task:p:b" },
        { id: "e2", type: "risks_in", from: "risk:p:a", to: "goal:p:c" },
        { id: "e3", type: "risks_in", from: "risk:p:a", to: "milestone:p:d" },
      ],
    };
    assert.deepStrictEqual(validateGraph(g, S), []);
  });

  it("encompasses: Theme → Goal/Decision/Risk/Task/Resource/Assumption/OperationalKnowledge/Constraint", () => {
    const g = {
      nodes: [
        { id: "theme:p:a", type: "Theme" },
        { id: "goal:p:b", type: "Goal" },
        { id: "assumption:p:c", type: "Assumption", certainty: "Assumed" },
        { id: "ok:p:d", type: "OperationalKnowledge" },
        { id: "constraint:p:e", type: "Constraint" },
      ],
      edges: [
        { id: "e1", type: "encompasses", from: "theme:p:a", to: "goal:p:b" },
        { id: "e2", type: "encompasses", from: "theme:p:a", to: "assumption:p:c" },
        { id: "e3", type: "encompasses", from: "theme:p:a", to: "ok:p:d" },
        { id: "e4", type: "encompasses", from: "theme:p:a", to: "constraint:p:e" },
      ],
    };
    assert.deepStrictEqual(validateGraph(g, S), []);
  });

  it("encompasses rejects Theme → Milestone (reach it via Theme → Goal → targets → Milestone)", () => {
    const g = {
      nodes: [
        { id: "theme:p:a", type: "Theme" },
        { id: "milestone:p:b", type: "Milestone" },
      ],
      edges: [
        { id: "e1", type: "encompasses", from: "theme:p:a", to: "milestone:p:b" },
      ],
    };
    assert.ok(validateGraph(g, S).some(f => f.includes("invalid type pair")));
  });

  it("rejects system-vault-only types (File, Layer, Component)", () => {
    const g1 = { nodes: [{ id: "file:p:a", type: "File" }], edges: [] };
    assert.ok(validateGraph(g1, S).some(f => f.includes("unknown node type")));

    const g2 = { nodes: [{ id: "layer:p:a", type: "Layer" }], edges: [] };
    assert.ok(validateGraph(g2, S).some(f => f.includes("unknown node type")));
  });

  it("rejects system-vault-only edge types (sets_policy_for, evidenced_by)", () => {
    const g = {
      nodes: [
        { id: "decision:p:a", type: "Decision" },
        { id: "source:p:b", type: "Source" },
      ],
      edges: [{ id: "e1", type: "sets_policy_for", from: "decision:p:a", to: "source:p:b" }],
    };
    assert.ok(validateGraph(g, S).some(f => f.includes("unknown edge type")));
  });

  it("cross-vault ref (vault: prefix) skips local existence check", () => {
    const g = {
      nodes: [
        { id: "task:p:a", type: "Task" },
      ],
      edges: [{ id: "e1", type: "requires", from: "task:p:a", to: "vault:platform-x/deliverable:platform-x:product-v2.0" }],
    };
    const failures = validateGraph(g, S);
    assert.ok(!failures.some(f => f.includes("missing")));
  });

  it("Assumption requires certainty field", () => {
    const g = {
      nodes: [{ id: "assumption:p:a", type: "Assumption", title: "test" }],
      edges: [],
    };
    const failures = validateGraph(g, S);
    assert.ok(failures.some(f => f.includes("requires field 'certainty'")));
  });

  it("Assumption rejects invalid certainty value", () => {
    const g = {
      nodes: [{ id: "assumption:p:a", type: "Assumption", certainty: "Maybe" }],
      edges: [],
    };
    const failures = validateGraph(g, S);
    assert.ok(failures.some(f => f.includes("invalid certainty")));
  });

  it("Assumption accepts valid certainty values", () => {
    for (const c of ["Established", "Expected", "Assumed", "Speculative"]) {
      const g = {
        nodes: [{ id: `assumption:p:${c}`, type: "Assumption", certainty: c }],
        edges: [],
      };
      assert.deepStrictEqual(validateGraph(g, S), []);
    }
  });

  it("triggered_by: Investigation → Risk/Source/Stakeholder", () => {
    const g = {
      nodes: [
        { id: "investigation:p:a", type: "Investigation" },
        { id: "risk:p:b", type: "Risk" },
        { id: "source:p:c", type: "Source" },
        { id: "stakeholder:p:d", type: "Stakeholder" },
      ],
      edges: [
        { id: "e1", type: "triggered_by", from: "investigation:p:a", to: "risk:p:b" },
        { id: "e2", type: "triggered_by", from: "investigation:p:a", to: "source:p:c" },
        { id: "e3", type: "triggered_by", from: "investigation:p:a", to: "stakeholder:p:d" },
      ],
    };
    assert.deepStrictEqual(validateGraph(g, S), []);
  });
});
