import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateGraph } from "./schema.ts";
import { getPreset } from "./schema-registry.ts";

const S = getPreset("principal")!;
const P = getPreset("project")!;

// principal = project の機械的減算 (Task/Milestone)。統治ルール「亜種は引き算のみ」の
// 検証はこのファイルが宣言的リストとして固定する (導出コードの期待結果の正本)。
describe("principal schema preset", () => {
  it("is registered and resolvable", () => {
    assert.ok(S);
    assert.strictEqual(S.id, "principal");
  });

  it("has 14 node types = project minus Task/Milestone, zero additions", () => {
    assert.strictEqual(S.nodeTypes.length, 14);
    assert.ok(!S.nodeTypes.includes("Task"));
    assert.ok(!S.nodeTypes.includes("Milestone"));
    for (const t of S.nodeTypes) {
      assert.ok(P.nodeTypes.includes(t), `principal added node type ${t} — variants may only subtract`);
    }
    // 判断層 + 当事者の語彙は無傷で継承
    for (const t of ["Decision", "RejectedOption", "Constraint", "Goal", "Risk",
                     "OperationalKnowledge", "Investigation", "ConversationChunk",
                     "Source", "Theme", "Stakeholder", "Resource", "Assumption", "Agreement"]) {
      assert.ok(S.nodeTypes.includes(t), `missing ${t}`);
    }
  });

  it("edge types: achieves/depends_on/targets are gone (rules emptied), excepts survives", () => {
    assert.ok(!S.edgeTypes.includes("achieves"));
    assert.ok(!S.edgeTypes.includes("depends_on"));
    assert.ok(!S.edgeTypes.includes("targets"));
    assert.ok(S.edgeTypes.includes("excepts"));
    assert.strictEqual(S.edgeTypes.length, 20);
    for (const e of S.edgeTypes) {
      assert.ok(P.edgeTypes.includes(e), `principal added edge type ${e} — variants may only subtract`);
    }
  });

  it("subtraction invariant: every principal rule is a narrowing of a project rule", () => {
    const asArray = (side: string | readonly string[]) =>
      typeof side === "string" ? [side] : [...side];
    for (const [edge, rules] of Object.entries(S.edgeTypeRules)) {
      const projectRules = P.edgeTypeRules[edge];
      assert.ok(projectRules, `edge ${edge} does not exist in project`);
      for (const [from, to] of rules) {
        const covered = projectRules.some(([pf, pt]) =>
          asArray(from).every((t) => asArray(pf).includes(t)) &&
          asArray(to).every((t) => asArray(pt).includes(t)));
        assert.ok(covered, `rule ${edge} [${asArray(from)}]→[${asArray(to)}] is not a subset of project's`);
      }
    }
  });

  it("requires: only Decision → Resource remains (perpetual policy premises a resource)", () => {
    assert.deepStrictEqual(S.edgeTypeRules["requires"], [["Decision", "Resource"]]);
    const g = {
      nodes: [
        { id: "decision:p:staffing-gap-fill", type: "Decision" },
        { id: "resource:p:sd-pool", type: "Resource" },
      ],
      edges: [{ id: "e1", type: "requires", from: "decision:p:staffing-gap-fill", to: "resource:p:sd-pool" }],
    };
    assert.deepStrictEqual(validateGraph(g, S), []);
  });

  it("falls_back_to: only Goal → Goal remains", () => {
    assert.deepStrictEqual(S.edgeTypeRules["falls_back_to"], [["Goal", "Goal"]]);
  });

  it("risks_in: only Risk → Goal remains", () => {
    assert.deepStrictEqual(S.edgeTypeRules["risks_in"], [["Risk", ["Goal"]]]);
  });

  it("Task node is rejected with the schema id in the message (型別ルーティングの一次シグナル)", () => {
    const g = { nodes: [{ id: "task:p:x", type: "Task" }], edges: [] };
    const failures = validateGraph(g, S);
    assert.deepStrictEqual(failures, ["unknown node type: Task (schema: principal)"]);
  });

  it("Milestone node is rejected", () => {
    const g = { nodes: [{ id: "milestone:p:x", type: "Milestone" }], edges: [] };
    assert.ok(validateGraph(g, S).some(f => f.includes("unknown node type: Milestone")));
  });

  it("excepts: Constraint(例外) → Constraint(原則)", () => {
    const g = {
      nodes: [
        { id: "constraint:p:late-payment-carve-out", type: "Constraint" },
        { id: "constraint:p:pay-before-completion", type: "Constraint" },
      ],
      edges: [{ id: "e1", type: "excepts", from: "constraint:p:late-payment-carve-out", to: "constraint:p:pay-before-completion" }],
    };
    assert.deepStrictEqual(validateGraph(g, S), []);
  });

  it("excepts rejects non-Constraint endpoints", () => {
    const g = {
      nodes: [
        { id: "constraint:p:a", type: "Constraint" },
        { id: "decision:p:b", type: "Decision" },
      ],
      edges: [{ id: "e1", type: "excepts", from: "constraint:p:a", to: "decision:p:b" }],
    };
    assert.ok(validateGraph(g, S).length > 0);
  });

  it("Constraint can cite its Source (反例A: 与件の接地は enforcer でなく出典)", () => {
    const g = {
      nodes: [
        { id: "constraint:p:remote-monitor-quality", type: "Constraint" },
        { id: "source:p:road-traffic-act-75-20", type: "Source", source_kind: "regulation" },
        { id: "conversation:p:c1", type: "ConversationChunk" },
      ],
      edges: [
        { id: "e1", type: "documented_by", from: "constraint:p:remote-monitor-quality", to: "source:p:road-traffic-act-75-20" },
        { id: "e2", type: "derived_from", from: "constraint:p:remote-monitor-quality", to: "conversation:p:c1" },
      ],
    };
    assert.deepStrictEqual(validateGraph(g, S), []);
  });

  it("Stakeholder / Resource can point at external masters via Source", () => {
    const g = {
      nodes: [
        { id: "stakeholder:p:regulator", type: "Stakeholder" },
        { id: "resource:p:budget", type: "Resource" },
        { id: "source:p:org-chart", type: "Source" },
      ],
      edges: [
        { id: "e1", type: "documented_by", from: "stakeholder:p:regulator", to: "source:p:org-chart" },
        { id: "e2", type: "documented_by", from: "resource:p:budget", to: "source:p:org-chart" },
      ],
    };
    assert.deepStrictEqual(validateGraph(g, S), []);
  });

  it("state vocabulary carries no Task/Milestone entries; Agreement/Goal/Investigation inherited", () => {
    assert.strictEqual(S.stateVocabulary["Task"], undefined);
    assert.strictEqual(S.stateVocabulary["Milestone"], undefined);
    assert.deepStrictEqual(S.stateVocabulary["Agreement"], P.stateVocabulary["Agreement"]);
    assert.deepStrictEqual(S.stateVocabulary["Goal"], P.stateVocabulary["Goal"]);
    assert.deepStrictEqual(S.stateVocabulary["Investigation"], P.stateVocabulary["Investigation"]);
  });

  it("categories are pruned of Task/Milestone but otherwise inherited", () => {
    for (const [name, list] of Object.entries(S.categories)) {
      assert.ok(!list.includes("Task"), `${name} still lists Task`);
      assert.ok(!list.includes("Milestone"), `${name} still lists Milestone`);
      for (const t of list) {
        assert.ok((P.categories as Record<string, readonly string[]>)[name].includes(t),
          `principal added ${t} to category ${name}`);
      }
    }
    assert.ok(S.categories.knowledge.includes("Agreement"));
    assert.ok(S.categories.crosscut.includes("Theme"));
  });

  it("Assumption still requires certainty", () => {
    const g = { nodes: [{ id: "assumption:p:x", type: "Assumption" }], edges: [] };
    assert.ok(validateGraph(g, S).some(f => f.includes("requires field 'certainty'")));
  });
});
