import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAddDecisionPlan,
  buildAddOkPlan,
  buildAddRiskPlan,
  buildAddInvestigationPlan,
  buildAddRejectedOptionPlan,
  buildAddConstraintPlan,
  buildAddGoalPlan
} from "./cli-typed-add.ts";

// テスト用ヘルパ: plan.edges から (type, from, to) を引く。
function edgeOf(plan: any, type: string) {
  return plan.edges.filter((e: any) => e.type === type);
}

test("buildAddDecisionPlan creates Decision node + documented_by edges, no contains", () => {
  const plan = buildAddDecisionPlan({
    system: "foo",
    slug: "use-x",
    title: "Use X",
    summary: "We use X because ...",
    evidence: ["file:foo:src/x.ts", "file:foo:src/y.ts"]
  });
  assert.equal(plan.nodes.length, 1);
  assert.equal(plan.nodes[0].id, "decision:foo:use-x");
  assert.equal(plan.nodes[0].type, "Decision");
  assert.equal(plan.nodes[0].title, "Use X");
  assert.equal(plan.edges.length, 2);
  for (const e of plan.edges) {
    assert.equal(e.type, "documented_by");
    assert.equal(e.from, "decision:foo:use-x");
    assert.ok(e.to.startsWith("file:foo:"));
  }
  // contains は書かない (mutate 側で自動付与)
  assert.equal(plan.edges.filter((e: any) => e.type === "contains").length, 0);
});

test("buildAddOkPlan creates OperationalKnowledge node", () => {
  const plan = buildAddOkPlan({
    system: "foo", slug: "gotcha", title: "OK", summary: "..."
  });
  assert.equal(plan.nodes[0].type, "OperationalKnowledge");
  assert.equal(plan.nodes[0].id, "operationalknowledge:foo:gotcha");
});

test("buildAddRiskPlan creates Risk node", () => {
  const plan = buildAddRiskPlan({
    system: "foo", slug: "boom", title: "R", summary: "..."
  });
  assert.equal(plan.nodes[0].type, "Risk");
  assert.equal(plan.nodes[0].id, "risk:foo:boom");
});

test("buildAddInvestigationPlan creates Investigation with raw_content + documented_by evidence", () => {
  const plan = buildAddInvestigationPlan({
    system: "foo",
    slug: "ep1",
    title: "I",
    summary: "...",
    rawContent: "代表コミット:\n- 2026-05-22 abc subject",
    evidence: ["file:foo:src/x.ts"]
  });
  assert.equal(plan.nodes[0].type, "Investigation");
  assert.equal(plan.nodes[0].id, "investigation:foo:ep1");
  assert.match(plan.nodes[0].raw_content, /代表コミット/);
  // evidence は documented_by (schema 上 Investigation → File も documented_by 許容)
  assert.equal(plan.edges.length, 1);
  assert.equal(plan.edges[0].type, "documented_by");
  assert.equal(plan.edges[0].from, "investigation:foo:ep1");
  assert.equal(plan.edges[0].to, "file:foo:src/x.ts");
});

test("buildAddInvestigationPlan defaults state to 'active' (resume が拾える前提を新規作成時に保証)", () => {
  const plan = buildAddInvestigationPlan({
    system: "foo", slug: "ep1", title: "I", summary: "...", rawContent: "raw"
  });
  assert.equal(plan.nodes[0].state, "active");
});

test("buildAddInvestigationPlan accepts --state override within vocabulary", () => {
  const plan = buildAddInvestigationPlan({
    system: "foo", slug: "ep1", title: "I", summary: "...", rawContent: "raw", state: "closed"
  });
  assert.equal(plan.nodes[0].state, "closed");
});

test("buildAddInvestigationPlan rejects out-of-vocabulary --state (typo ゾンビ防止)", () => {
  assert.throws(() => buildAddInvestigationPlan({
    system: "foo", slug: "ep1", title: "I", summary: "...", rawContent: "raw", state: "done"
  }), /invalid --state "done" \(allowed: active, closed\)/);
});

test("buildAddRejectedOptionPlan requires --rejected-in-favor-of", () => {
  assert.throws(() => buildAddRejectedOptionPlan({
    system: "foo", slug: "tried-y", title: "Y", summary: "failure mode Z"
  } as any), /rejected-in-favor-of/);
});

test("buildAddRejectedOptionPlan creates RejectedOption + supersedes edge from chosen Decision (schema-correct)", () => {
  // schema 上 'rejected_in' は RejectedOption → Investigation のみ許容。
  // 'Decision が RejectedOption を選ばなかった' を表す唯一のエッジは Decision → RejectedOption の 'supersedes'。
  // (--rejected-in-favor-of の flag 名は UX、edge は逆向きに作る)
  const plan = buildAddRejectedOptionPlan({
    system: "foo",
    slug: "tried-y",
    title: "Y",
    summary: "failure mode Z",
    rejectedInFavorOf: "decision:foo:use-x",
    evidence: ["file:foo:src/y.ts"]
  });
  assert.equal(plan.nodes[0].type, "RejectedOption");
  assert.equal(plan.nodes[0].id, "rejectedoption:foo:tried-y");
  const supersedesEdge = plan.edges.find((e: any) => e.type === "supersedes");
  assert.ok(supersedesEdge, "supersedes edge missing");
  assert.equal(supersedesEdge.from, "decision:foo:use-x", "supersedes は Decision → RejectedOption");
  assert.equal(supersedesEdge.to, "rejectedoption:foo:tried-y");
  // evidence は documented_by (RejectedOption → File)
  const evidenceEdges = plan.edges.filter((e: any) => e.type === "documented_by");
  assert.equal(evidenceEdges.length, 1);
  assert.equal(evidenceEdges[0].from, "rejectedoption:foo:tried-y");
  assert.equal(evidenceEdges[0].to, "file:foo:src/y.ts");
});

test("plan.reason は LLM 提供 reason または default", () => {
  const plan = buildAddDecisionPlan({
    system: "foo", slug: "use-x", title: "Use X", summary: "..."
  });
  assert.ok(typeof plan.reason === "string" && plan.reason.length > 0);
});

test("custom reason is preserved", () => {
  const plan = buildAddDecisionPlan({
    system: "foo", slug: "use-x", title: "Use X", summary: "...",
    reason: "ユーザーが結論を述べた"
  });
  assert.equal(plan.reason, "ユーザーが結論を述べた");
});

test("optional description is carried onto the node when provided", () => {
  const plan = buildAddDecisionPlan({
    system: "foo", slug: "use-x", title: "Use X", summary: "見出し",
    description: "なぜ X を選んだかの蒸留散文"
  });
  assert.equal(plan.nodes[0].description, "なぜ X を選んだかの蒸留散文");
});

test("description is omitted (not undefined-stamped) when absent or blank", () => {
  const noDesc = buildAddRiskPlan({ system: "foo", slug: "boom", title: "R", summary: "..." });
  assert.ok(!("description" in noDesc.nodes[0]), "absent description must not appear as a key");
  const blank = buildAddOkPlan({ system: "foo", slug: "g", title: "OK", summary: "...", description: "   " });
  assert.ok(!("description" in blank.nodes[0]), "blank description must not appear as a key");
});

// ───────────────────────── R3 aliases (全 verb) ─────────────────────────

test("aliases は指定時に node に string[] として載る (全 verb)", () => {
  const d = buildAddDecisionPlan({ system: "foo", slug: "x", title: "T", summary: "S", aliases: ["a", "b"] });
  assert.deepEqual(d.nodes[0].aliases, ["a", "b"]);
  const ok = buildAddOkPlan({ system: "foo", slug: "x", title: "T", summary: "S", aliases: ["c"] });
  assert.deepEqual(ok.nodes[0].aliases, ["c"]);
  const r = buildAddRiskPlan({ system: "foo", slug: "x", title: "T", summary: "S", aliases: ["d"] });
  assert.deepEqual(r.nodes[0].aliases, ["d"]);
  const inv = buildAddInvestigationPlan({ system: "foo", slug: "x", title: "T", summary: "S", rawContent: "raw", aliases: ["e"] });
  assert.deepEqual(inv.nodes[0].aliases, ["e"]);
  const ro = buildAddRejectedOptionPlan({ system: "foo", slug: "x", title: "T", summary: "S", rejectedInFavorOf: "decision:foo:y", aliases: ["f"] });
  assert.deepEqual(ro.nodes[0].aliases, ["f"]);
  const c = buildAddConstraintPlan({ system: "foo", slug: "x", title: "T", summary: "S", constrains: ["file:foo:a.ts"], aliases: ["g"] });
  assert.deepEqual(c.nodes[0].aliases, ["g"]);
  const g = buildAddGoalPlan({ system: "foo", slug: "x", title: "T", summary: "S", aliases: ["h"] });
  assert.deepEqual(g.nodes[0].aliases, ["h"]);
});

test("aliases は未指定/空/空白のみのとき node にキーを撒かない", () => {
  const none = buildAddDecisionPlan({ system: "foo", slug: "x", title: "T", summary: "S" });
  assert.ok(!("aliases" in none.nodes[0]), "absent aliases must not appear as a key");
  const empty = buildAddDecisionPlan({ system: "foo", slug: "x", title: "T", summary: "S", aliases: [] });
  assert.ok(!("aliases" in empty.nodes[0]), "empty aliases must not appear as a key");
  const blank = buildAddDecisionPlan({ system: "foo", slug: "x", title: "T", summary: "S", aliases: ["  ", ""] });
  assert.ok(!("aliases" in blank.nodes[0]), "blank-only aliases must not appear as a key");
});

// ───────────────────────── E1 add-decision 追加エッジ ─────────────────────────

test("add-decision --sets-policy-for は Decision → 宛先の sets_policy_for エッジを作る", () => {
  const plan = buildAddDecisionPlan({
    system: "foo", slug: "use-x", title: "T", summary: "S",
    setsPolicyFor: ["file:foo:a.ts", "layer:foo:band1"]
  });
  const edges = edgeOf(plan, "sets_policy_for");
  assert.equal(edges.length, 2);
  for (const e of edges) {
    assert.equal(e.from, "decision:foo:use-x");
  }
  assert.deepEqual(edges.map((e: any) => e.to).sort(), ["file:foo:a.ts", "layer:foo:band1"]);
});

test("add-decision --premise は Decision → 宛先の has_premise エッジを作る", () => {
  const plan = buildAddDecisionPlan({
    system: "foo", slug: "use-x", title: "T", summary: "S",
    premise: ["constraint:foo:c1", "risk:foo:r1", "goal:foo:g1"]
  });
  const edges = edgeOf(plan, "has_premise");
  assert.equal(edges.length, 3);
  assert.ok(edges.every((e: any) => e.from === "decision:foo:use-x"));
});

test("add-decision --reduces-risk は Decision → Risk の reduces_risk エッジを作る", () => {
  const plan = buildAddDecisionPlan({
    system: "foo", slug: "use-x", title: "T", summary: "S", reducesRisk: ["risk:foo:r1"]
  });
  const edges = edgeOf(plan, "reduces_risk");
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, "decision:foo:use-x");
  assert.equal(edges[0].to, "risk:foo:r1");
});

test("add-decision --refines は Decision → Decision の refines エッジを作る", () => {
  const plan = buildAddDecisionPlan({
    system: "foo", slug: "use-x", title: "T", summary: "S", refines: "decision:foo:old"
  });
  const edges = edgeOf(plan, "refines");
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, "decision:foo:use-x");
  assert.equal(edges[0].to, "decision:foo:old");
});

test("add-decision --from-investigation は Investigation → Decision 向き (led_to)", () => {
  const plan = buildAddDecisionPlan({
    system: "foo", slug: "use-x", title: "T", summary: "S", fromInvestigation: "investigation:foo:ep1"
  });
  const edges = edgeOf(plan, "led_to");
  assert.equal(edges.length, 1);
  // 向きは investigation → 新 Decision (from が investigation であること)
  assert.equal(edges[0].from, "investigation:foo:ep1");
  assert.equal(edges[0].to, "decision:foo:use-x");
});

test("add-decision の文法違反フラグは throw (sets-policy-for に Decision 不可宛先)", () => {
  // sets_policy_for の宛先に Risk は許されない (File|Investigation|OK|Layer|Concern|Component のみ)
  assert.throws(() => buildAddDecisionPlan({
    system: "foo", slug: "use-x", title: "T", summary: "S", setsPolicyFor: ["risk:foo:r1"]
  }), /sets-policy-for.*risk:foo:r1.*sets_policy_for/);
});

test("add-decision --premise に文法外宛先 (File) は throw", () => {
  assert.throws(() => buildAddDecisionPlan({
    system: "foo", slug: "use-x", title: "T", summary: "S", premise: ["file:foo:a.ts"]
  }), /--premise.*file:foo:a\.ts/);
});

test("add-decision --from-investigation に Investigation 以外を渡すと throw", () => {
  assert.throws(() => buildAddDecisionPlan({
    system: "foo", slug: "use-x", title: "T", summary: "S", fromInvestigation: "decision:foo:other"
  }), /--from-investigation.*Investigation/);
});

test("add-decision --refines に Decision/OK 以外 (Risk) は throw", () => {
  assert.throws(() => buildAddDecisionPlan({
    system: "foo", slug: "use-x", title: "T", summary: "S", refines: "risk:foo:r1"
  }), /--refines.*risk:foo:r1/);
});

// ───────────────────────── E1 add-ok 追加エッジ ─────────────────────────

test("add-ok --premise / --reduces-risk / --refines は OperationalKnowledge 起点で作られる", () => {
  const plan = buildAddOkPlan({
    system: "foo", slug: "gotcha", title: "T", summary: "S",
    premise: ["decision:foo:d1"], reducesRisk: ["risk:foo:r1"], refines: "operationalknowledge:foo:old"
  });
  const id = "operationalknowledge:foo:gotcha";
  assert.equal(edgeOf(plan, "has_premise")[0].from, id);
  assert.equal(edgeOf(plan, "has_premise")[0].to, "decision:foo:d1");
  assert.equal(edgeOf(plan, "reduces_risk")[0].from, id);
  assert.equal(edgeOf(plan, "reduces_risk")[0].to, "risk:foo:r1");
  assert.equal(edgeOf(plan, "refines")[0].from, id);
  assert.equal(edgeOf(plan, "refines")[0].to, "operationalknowledge:foo:old");
});

test("add-ok --refines は OK → Decision も許す (schema: refines [Decision|OK] -> [Decision|OK])", () => {
  const plan = buildAddOkPlan({
    system: "foo", slug: "gotcha", title: "T", summary: "S", refines: "decision:foo:d1"
  });
  assert.equal(edgeOf(plan, "refines")[0].to, "decision:foo:d1");
});

test("add-ok 文法違反 (reduces-risk に Risk 以外) は throw", () => {
  assert.throws(() => buildAddOkPlan({
    system: "foo", slug: "gotcha", title: "T", summary: "S", reducesRisk: ["decision:foo:d1"]
  }), /--reduces-risk.*decision:foo:d1/);
});

// ───────────────────────── E1 add-risk 追加エッジ ─────────────────────────

test("add-risk --risks-in は Risk → 宛先の risks_in エッジを作る", () => {
  const plan = buildAddRiskPlan({
    system: "foo", slug: "boom", title: "T", summary: "S",
    risksIn: ["decision:foo:d1", "file:foo:a.ts", "component:foo:c1"]
  });
  const edges = edgeOf(plan, "risks_in");
  assert.equal(edges.length, 3);
  assert.ok(edges.every((e: any) => e.from === "risk:foo:boom"));
});

test("add-risk --risks-in 文法違反 (Risk 宛先不可: Goal) は throw", () => {
  assert.throws(() => buildAddRiskPlan({
    system: "foo", slug: "boom", title: "T", summary: "S", risksIn: ["goal:foo:g1"]
  }), /--risks-in.*goal:foo:g1/);
});

// ───────────────────────── E2 add-constraint (新設) ─────────────────────────

test("add-constraint は Constraint ノード + constrains エッジ (≥1) を作る", () => {
  const plan = buildAddConstraintPlan({
    system: "foo", slug: "no-npm", title: "npm 禁止", summary: "pnpm 一択",
    constrains: ["decision:foo:d1", "file:foo:a.ts", "operationalknowledge:foo:ok1"]
  });
  assert.equal(plan.nodes[0].type, "Constraint");
  assert.equal(plan.nodes[0].id, "constraint:foo:no-npm");
  const edges = edgeOf(plan, "constrains");
  assert.equal(edges.length, 3);
  assert.ok(edges.every((e: any) => e.from === "constraint:foo:no-npm"));
});

test("add-constraint は --constrains ≥1 を必須 (空/未指定は throw)", () => {
  assert.throws(() => buildAddConstraintPlan({
    system: "foo", slug: "no-npm", title: "T", summary: "S", constrains: []
  }), /--constrains is required/);
  assert.throws(() => buildAddConstraintPlan({
    system: "foo", slug: "no-npm", title: "T", summary: "S"
  } as any), /--constrains is required/);
});

test("add-constraint は documented_by を作らない (Constraint は evidence 不可)", () => {
  const plan = buildAddConstraintPlan({
    system: "foo", slug: "no-npm", title: "T", summary: "S", constrains: ["file:foo:a.ts"]
  });
  assert.equal(edgeOf(plan, "documented_by").length, 0);
});

test("add-constraint 文法違反 (constrains 宛先不可: Risk) は throw", () => {
  assert.throws(() => buildAddConstraintPlan({
    system: "foo", slug: "no-npm", title: "T", summary: "S", constrains: ["risk:foo:r1"]
  }), /--constrains.*risk:foo:r1/);
});

// ───────────────────────── E2 add-goal (新設) ─────────────────────────

test("add-goal は Goal ノードを作る (既定 state なし)", () => {
  const plan = buildAddGoalPlan({ system: "foo", slug: "fast-retrieval", title: "T", summary: "S" });
  assert.equal(plan.nodes[0].type, "Goal");
  assert.equal(plan.nodes[0].id, "goal:foo:fast-retrieval");
  assert.ok(!("state" in plan.nodes[0]), "既定では state を撒かない");
  assert.equal(plan.edges.length, 0);
});

test("add-goal --refines は Goal → Goal の refines エッジ", () => {
  const plan = buildAddGoalPlan({
    system: "foo", slug: "g2", title: "T", summary: "S", refines: "goal:foo:g1"
  });
  const edges = edgeOf(plan, "refines");
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, "goal:foo:g2");
  assert.equal(edges[0].to, "goal:foo:g1");
});

test("add-goal --derived-from は Goal → ConversationChunk|Investigation の derived_from", () => {
  const fromInv = buildAddGoalPlan({
    system: "foo", slug: "g2", title: "T", summary: "S", derivedFrom: "investigation:foo:ep1"
  });
  assert.equal(edgeOf(fromInv, "derived_from")[0].to, "investigation:foo:ep1");
  const fromConv = buildAddGoalPlan({
    system: "foo", slug: "g3", title: "T", summary: "S", derivedFrom: "conversationchunk:foo:cc1"
  });
  assert.equal(edgeOf(fromConv, "derived_from")[0].to, "conversationchunk:foo:cc1");
});

test("add-goal --state は STATE_VOCABULARY.Goal を検証 (語彙内は受理)", () => {
  for (const s of ["planned", "active", "achieved", "abandoned"]) {
    const plan = buildAddGoalPlan({ system: "foo", slug: "g", title: "T", summary: "S", state: s });
    assert.equal(plan.nodes[0].state, s);
  }
});

test("add-goal --state 語彙外は throw (typo ゾンビ防止)", () => {
  assert.throws(() => buildAddGoalPlan({
    system: "foo", slug: "g", title: "T", summary: "S", state: "done"
  }), /invalid --state "done" \(allowed: planned, active, achieved, abandoned\)/);
});

test("add-goal --refines 文法違反 (Goal 以外: Decision) は throw", () => {
  assert.throws(() => buildAddGoalPlan({
    system: "foo", slug: "g2", title: "T", summary: "S", refines: "decision:foo:d1"
  }), /--refines.*decision:foo:d1/);
});

test("add-goal --derived-from 文法違反 (Decision は宛先不可) は throw", () => {
  assert.throws(() => buildAddGoalPlan({
    system: "foo", slug: "g2", title: "T", summary: "S", derivedFrom: "decision:foo:d1"
  }), /--derived-from.*decision:foo:d1/);
});

// ───── 回帰: 向きが固定されたエッジが既存のまま保たれること ─────

test("回帰: supersedes は Decision → RejectedOption 方向 (変えない)", () => {
  const plan = buildAddRejectedOptionPlan({
    system: "foo", slug: "tried-y", title: "Y", summary: "S", rejectedInFavorOf: "decision:foo:use-x"
  });
  const e = edgeOf(plan, "supersedes")[0];
  assert.equal(e.from, "decision:foo:use-x");
  assert.equal(e.to, "rejectedoption:foo:tried-y");
});

test("歴史的 id 接頭辞 (conversation:/ok:/rejected-option:/operational-knowledge:) を文法検証が解決する", () => {
  // dev-vault / gestalty の実在 id 表記。3.8.0 初版が unknown 扱いで正当なエッジを弾いた回帰
  const plan = buildAddGoalPlan({
    system: "s", slug: "g", title: "t", summary: "s",
    derivedFrom: "conversation:2026-06-12:veteran-vision"
  });
  assert.equal(plan.edges[0].type, "derived_from");
  assert.equal(plan.edges[0].to, "conversation:2026-06-12:veteran-vision");
  const okPlan = buildAddDecisionPlan({
    system: "s", slug: "d", title: "t", summary: "s",
    evidence: ["file:s:a.ts"], premise: ["ok:s:some-knowhow", "operational-knowledge:s:other"]
  });
  assert.equal(okPlan.edges.filter((e) => e.type === "has_premise").length, 2);
  const supPlan = buildAddRejectedOptionPlan({
    system: "s", slug: "r", title: "t", summary: "s",
    evidence: ["file:s:a.ts"], rejectedInFavorOf: "decision:s:chosen"
  });
  assert.equal(supPlan.edges.find((e) => e.type === "supersedes").to, "rejectedoption:s:r");
});
