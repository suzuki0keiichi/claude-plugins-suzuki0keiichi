import assert from "node:assert/strict";
import test from "node:test";
import { validateGraph, NODE_TYPES, STATE_VOCABULARY } from "./schema.ts";

test("validateGraph rejects invalid edge source and target type pairs", () => {
  const graph = {
    nodes: [
      { id: "decision:test", type: "Decision" },
      { id: "risk:test", type: "Risk" }
    ],
    edges: [
      {
        id: "edge:test:invalid",
        type: "reduces_risk",
        from: "risk:test",
        to: "decision:test"
      }
    ]
  };

  assert.deepEqual(validateGraph(graph), [
    "edge edge:test:invalid has invalid type pair for reduces_risk: Risk -> Decision"
  ]);
});

test("root scope types and contains are removed (vault=scope)", () => {
  for (const t of ["System", "Product", "Project", "Business"]) {
    assert.ok(!NODE_TYPES.includes(t), `NODE_TYPES must not include ${t}`);
    const failures = validateGraph({
      nodes: [{ id: `${t.toLowerCase()}:acme:x`, type: t }],
      edges: []
    });
    assert.deepEqual(failures, [`unknown node type: ${t}`]);
  }
  const containsFailures = validateGraph({
    nodes: [
      { id: "decision:acme:flow", type: "Decision" },
      { id: "goal:acme:arr", type: "Goal" }
    ],
    edges: [
      { id: "e:1", type: "contains", from: "decision:acme:flow", to: "goal:acme:arr" }
    ]
  });
  assert.ok(containsFailures.some((f) => f.includes("unknown edge type: contains")));
});

test("refines allows Goal->Goal but not Decision->Goal", () => {
  const ok = validateGraph({
    nodes: [
      { id: "goal:sys:a", type: "Goal" },
      { id: "goal:sys:b", type: "Goal" }
    ],
    edges: [{ id: "e:1", type: "refines", from: "goal:sys:a", to: "goal:sys:b" }]
  });
  assert.deepEqual(ok, []);

  const bad = validateGraph({
    nodes: [
      { id: "decision:sys:a", type: "Decision" },
      { id: "goal:sys:b", type: "Goal" }
    ],
    edges: [{ id: "e:2", type: "refines", from: "decision:sys:a", to: "goal:sys:b" }]
  });
  assert.deepEqual(bad, [
    "edge e:2 has invalid type pair for refines: Decision -> Goal"
  ]);
});

test("Decision has_premise Goal is valid", () => {
  const failures = validateGraph({
    nodes: [
      { id: "decision:sys:shard", type: "Decision" },
      { id: "goal:sys:p99", type: "Goal" }
    ],
    edges: [
      { id: "e:1", type: "has_premise", from: "decision:sys:shard", to: "goal:sys:p99" }
    ]
  });
  assert.deepEqual(failures, []);
});

test("all legacy crosscut aliases validate as canonical", () => {
  for (const [alias, canonical] of [
    ["Stratum", "Layer"],
    ["Vein", "Concern"],
    ["Pocket", "Component"]
  ] as const) {
    const failures = validateGraph({
      nodes: [
        { id: `${alias.toLowerCase()}:sys:x`, type: alias },
        { id: "file:sys:x.ts", type: "File" }
      ],
      edges: [{ id: "e:1", type: "evidenced_by", from: `${alias.toLowerCase()}:sys:x`, to: "file:sys:x.ts" }]
    });
    assert.deepEqual(failures, [], `alias ${alias} should pass as ${canonical}`);
  }
});

test("crosscut types are Layer/Concern/Component and evidence File", () => {
  for (const t of ["Layer", "Concern", "Component"]) {
    assert.ok(NODE_TYPES.includes(t), `NODE_TYPES must include ${t}`);
  }
  const failures = validateGraph({
    nodes: [
      { id: "concern:acme:auth", type: "Concern" },
      { id: "file:acme:a.ts", type: "File" }
    ],
    edges: [
      { id: "e:1", type: "evidenced_by", from: "concern:acme:auth", to: "file:acme:a.ts" }
    ]
  });
  assert.deepEqual(failures, []);
});

test("Goal is a recognized node type", () => {
  assert.ok(NODE_TYPES.includes("Goal"), "NODE_TYPES must include Goal");
  const failures = validateGraph({
    nodes: [{ id: "goal:sys:p99", type: "Goal" }],
    edges: []
  });
  assert.deepEqual(failures, []);
});

test("validateGraph rejects duplicate edge ids", () => {
  const graph = {
    nodes: [
      { id: "decision:test", type: "Decision" },
      { id: "risk:test", type: "Risk" }
    ],
    edges: [
      {
        id: "edge:test:duplicate",
        type: "reduces_risk",
        from: "decision:test",
        to: "risk:test"
      },
      {
        id: "edge:test:duplicate",
        type: "risks_in",
        from: "risk:test",
        to: "decision:test"
      }
    ]
  };

  assert.deepEqual(validateGraph(graph), [
    "duplicate edge id: edge:test:duplicate"
  ]);
});


test("sets_policy_for and risks_in allow crosscut targets (Layer/Concern/Component)", () => {
  const failures = validateGraph({
    nodes: [
      { id: "decision:s:idempotent-payment", type: "Decision" },
      { id: "risk:s:cache-consistency", type: "Risk" },
      { id: "component:s:payment", type: "Component" },
      { id: "layer:s:app", type: "Layer" },
      { id: "concern:s:logging", type: "Concern" }
    ],
    edges: [
      { id: "e1", type: "sets_policy_for", from: "decision:s:idempotent-payment", to: "component:s:payment" },
      { id: "e2", type: "sets_policy_for", from: "decision:s:idempotent-payment", to: "layer:s:app" },
      { id: "e3", type: "sets_policy_for", from: "decision:s:idempotent-payment", to: "concern:s:logging" },
      { id: "e4", type: "risks_in", from: "risk:s:cache-consistency", to: "component:s:payment" },
      { id: "e5", type: "risks_in", from: "risk:s:cache-consistency", to: "layer:s:app" },
      { id: "e6", type: "risks_in", from: "risk:s:cache-consistency", to: "concern:s:logging" }
    ]
  });
  assert.deepEqual(failures, []);
});

test("constrains does not allow crosscut targets (extension deferred until needed)", () => {
  const failures = validateGraph({
    nodes: [
      { id: "constraint:s:gdpr", type: "Constraint" },
      { id: "component:s:payment", type: "Component" }
    ],
    edges: [
      { id: "e1", type: "constrains", from: "constraint:s:gdpr", to: "component:s:payment" }
    ]
  });
  assert.deepEqual(failures, [
    "edge e1 has invalid type pair for constrains: Constraint -> Component"
  ]);
});

test("STATE_VOCABULARY exposes the agreed closed sets", () => {
  assert.deepEqual(STATE_VOCABULARY.Investigation, ["active", "closed"]);
  assert.deepEqual(STATE_VOCABULARY.Decision, ["superseded"]);
  assert.deepEqual(STATE_VOCABULARY.OperationalKnowledge, ["superseded"]);
  assert.deepEqual(STATE_VOCABULARY.Goal, ["planned", "active", "achieved", "abandoned"]);
  assert.ok(!("Risk" in STATE_VOCABULARY), "Risk は state を持たない");
});

test("validateGraph accepts in-vocabulary states and stateless nodes", () => {
  const failures = validateGraph({
    nodes: [
      { id: "investigation:s:a", type: "Investigation", state: "active" },
      { id: "investigation:s:b", type: "Investigation", state: "closed" },
      { id: "decision:s:old", type: "Decision", state: "superseded" },
      { id: "decision:s:now", type: "Decision" }, // state 無し = 現役、常に合法
      { id: "operationalknowledge:s:x", type: "OperationalKnowledge", state: "superseded" },
      { id: "goal:s:p", type: "Goal", state: "planned" },
      { id: "goal:s:d", type: "Goal", state: "abandoned" }
    ],
    edges: []
  });
  assert.deepEqual(failures, []);
});

test("validateGraph rejects out-of-vocabulary state values (typo zombies)", () => {
  const failures = validateGraph({
    nodes: [{ id: "decision:s:old", type: "Decision", state: "superceded" }],
    edges: []
  });
  assert.deepEqual(failures, [
    "node decision:s:old has invalid state for Decision: superceded (allowed: superseded)"
  ]);
});

test("validateGraph rejects state on types without a vocabulary", () => {
  const failures = validateGraph({
    nodes: [{ id: "risk:s:boom", type: "Risk", state: "active" }],
    edges: []
  });
  assert.deepEqual(failures, [
    "node risk:s:boom (Risk) must not have state: active"
  ]);
});

test("validateGraph rejects closed on Decision (vocabularies are per-type)", () => {
  const failures = validateGraph({
    nodes: [{ id: "decision:s:x", type: "Decision", state: "closed" }],
    edges: []
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /invalid state for Decision: closed/);
});

test("Component node with vault_ref attribute passes validation (extra attributes are ignored)", () => {
  const failures = validateGraph({
    nodes: [
      { id: "component:cloud-svc:billing", type: "Component", vault_ref: "billing" },
      { id: "component:cloud-svc:local", type: "Component", vault_ref: null }
    ],
    edges: []
  });
  assert.deepEqual(failures, []);
});

test("Goal/Investigation can be derived_from ConversationChunk (Requirement migration)", () => {
  const failures = validateGraph({
    nodes: [
      { id: "goal:s:a", type: "Goal" },
      { id: "investigation:s:b", type: "Investigation" },
      { id: "conversation:s:c", type: "ConversationChunk" }
    ],
    edges: [
      { id: "e1", type: "derived_from", from: "goal:s:a", to: "conversation:s:c" },
      { id: "e2", type: "derived_from", from: "investigation:s:b", to: "conversation:s:c" }
    ]
  });
  assert.deepEqual(failures, []);
});
