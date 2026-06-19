// check-carving project vault checks (P1–P7)
//
// Unit tests for runProjectChecks() and --schema project CLI integration tests.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProjectChecks } from "./check-carving.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "check-carving.ts");

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function buildEdgeMaps(edges: any[]): {
  outEdges: Record<string, any[]>;
  inEdges: Record<string, any[]>;
} {
  const outEdges: Record<string, any[]> = {};
  const inEdges: Record<string, any[]> = {};
  for (const e of edges) {
    (outEdges[e.from] = outEdges[e.from] ?? []).push(e);
    (inEdges[e.to] = inEdges[e.to] ?? []).push(e);
  }
  return { outEdges, inEdges };
}

function runWithSchema(graph: any): { code: number; out: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-proj-"));
  const gp = path.join(dir, "graph.json");
  writeFileSync(gp, JSON.stringify(graph));
  try {
    const out = execFileSync(
      "node",
      ["--experimental-strip-types", CLI, "--graph", gp, "--schema", "project"],
      { encoding: "utf8" }
    );
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: String(e.stdout ?? "") };
  }
}

// ──────────────────────────────────────────────────────────────
// P1: Agreement exploring concentration
// ──────────────────────────────────────────────────────────────

test("P1: 2+ exploring Agreements with no responsible_for should trigger agreement-exploring-concentration WARN", () => {
  const nodes = [
    { id: "agreement:p:ag1", type: "Agreement", title: "合意1", summary: "s", state: "exploring" },
    { id: "agreement:p:ag2", type: "Agreement", title: "合意2", summary: "s", state: "exploring" },
  ];
  const edges: any[] = [];
  const { outEdges, inEdges } = buildEdgeMaps(edges);
  const findings = runProjectChecks({ nodes, edges }, outEdges, inEdges);
  const rules = findings.map(f => f.rule);
  assert.ok(rules.includes("agreement-exploring-concentration"), "2 unowned items should trigger WARN");
  const f = findings.find(f => f.rule === "agreement-exploring-concentration")!;
  assert.equal(f.severity, "WARN");
});

test("P1: only 1 exploring Agreement should not trigger agreement-exploring-concentration", () => {
  const nodes = [
    { id: "agreement:p:ag1", type: "Agreement", title: "合意1", summary: "s", state: "exploring" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps([]);
  const findings = runProjectChecks({ nodes, edges: [] }, outEdges, inEdges);
  assert.ok(!findings.some(f => f.rule === "agreement-exploring-concentration"), "1 item should not trigger WARN");
});

test("P1: exploring Agreements with responsible_for should be excluded from the count", () => {
  // ag1 has responsible_for, ag2 does not → only 1 unowned → no WARN
  const nodes = [
    { id: "agreement:p:ag1", type: "Agreement", title: "合意1", summary: "s", state: "exploring" },
    { id: "agreement:p:ag2", type: "Agreement", title: "合意2", summary: "s", state: "exploring" },
    { id: "stakeholder:p:sh1", type: "Stakeholder", title: "SH1", summary: "s" },
  ];
  const edges = [
    { id: "e1", type: "responsible_for", from: "stakeholder:p:sh1", to: "agreement:p:ag1" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps(edges);
  const findings = runProjectChecks({ nodes, edges }, outEdges, inEdges);
  // ag1 has responsible_for → only ag2 is unowned (1 item) → no WARN
  assert.ok(!findings.some(f => f.rule === "agreement-exploring-concentration"),
    "1 Agreement has an owner, so only 1 is unowned → no WARN");
});

// ──────────────────────────────────────────────────────────────
// P2: Agreement negotiating stagnation
// ──────────────────────────────────────────────────────────────

test("P2: Agreement with state=negotiating should trigger agreement-negotiating-stagnation WARN", () => {
  const nodes = [
    { id: "agreement:p:ag1", type: "Agreement", title: "交渉中", summary: "s", state: "negotiating" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps([]);
  const findings = runProjectChecks({ nodes, edges: [] }, outEdges, inEdges);
  assert.ok(findings.some(f => f.rule === "agreement-negotiating-stagnation"), "negotiating state should trigger WARN");
  const f = findings.find(f => f.rule === "agreement-negotiating-stagnation")!;
  assert.equal(f.severity, "WARN");
  assert.ok(f.details && (f.details as string[]).some((d: string) => d.includes("ag1")), "details に ag1 が出る");
});

test("P2: 0 negotiating Agreements should not trigger agreement-negotiating-stagnation", () => {
  const nodes = [
    { id: "agreement:p:ag1", type: "Agreement", title: "合意", summary: "s", state: "active" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps([]);
  const findings = runProjectChecks({ nodes, edges: [] }, outEdges, inEdges);
  assert.ok(!findings.some(f => f.rule === "agreement-negotiating-stagnation"));
});

// ──────────────────────────────────────────────────────────────
// P3: Stakeholder overload
// ──────────────────────────────────────────────────────────────

test("P3: Stakeholder party_to 3 active Agreements should trigger stakeholder-overload WARN", () => {
  const nodes = [
    { id: "stakeholder:p:sh1", type: "Stakeholder", title: "SH1", summary: "s" },
    { id: "agreement:p:ag1", type: "Agreement", title: "A1", summary: "s", state: "active" },
    { id: "agreement:p:ag2", type: "Agreement", title: "A2", summary: "s", state: "active" },
    { id: "agreement:p:ag3", type: "Agreement", title: "A3", summary: "s", state: "active" },
  ];
  const edges = [
    { id: "e1", type: "party_to", from: "stakeholder:p:sh1", to: "agreement:p:ag1" },
    { id: "e2", type: "party_to", from: "stakeholder:p:sh1", to: "agreement:p:ag2" },
    { id: "e3", type: "party_to", from: "stakeholder:p:sh1", to: "agreement:p:ag3" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps(edges);
  const findings = runProjectChecks({ nodes, edges }, outEdges, inEdges);
  assert.ok(findings.some(f => f.rule === "stakeholder-overload"), "3 items should trigger WARN");
  const f = findings.find(f => f.rule === "stakeholder-overload")!;
  assert.equal(f.severity, "WARN");
  assert.ok(f.message.includes("sh1") || (f.details as string[]).some((d: string) => d.includes("sh1")));
});

test("P3: 2 active Agreements should not trigger stakeholder-overload", () => {
  const nodes = [
    { id: "stakeholder:p:sh1", type: "Stakeholder", title: "SH1", summary: "s" },
    { id: "agreement:p:ag1", type: "Agreement", title: "A1", summary: "s", state: "active" },
    { id: "agreement:p:ag2", type: "Agreement", title: "A2", summary: "s", state: "active" },
  ];
  const edges = [
    { id: "e1", type: "party_to", from: "stakeholder:p:sh1", to: "agreement:p:ag1" },
    { id: "e2", type: "party_to", from: "stakeholder:p:sh1", to: "agreement:p:ag2" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps(edges);
  const findings = runProjectChecks({ nodes, edges }, outEdges, inEdges);
  assert.ok(!findings.some(f => f.rule === "stakeholder-overload"), "2 items should not trigger WARN");
});

test("P3: non-active Agreements in party_to should not be counted", () => {
  // 3 party_to edges but 1 is signed → active count is 2 → no WARN
  const nodes = [
    { id: "stakeholder:p:sh1", type: "Stakeholder", title: "SH1", summary: "s" },
    { id: "agreement:p:ag1", type: "Agreement", title: "A1", summary: "s", state: "active" },
    { id: "agreement:p:ag2", type: "Agreement", title: "A2", summary: "s", state: "active" },
    { id: "agreement:p:ag3", type: "Agreement", title: "A3", summary: "s", state: "signed" },
  ];
  const edges = [
    { id: "e1", type: "party_to", from: "stakeholder:p:sh1", to: "agreement:p:ag1" },
    { id: "e2", type: "party_to", from: "stakeholder:p:sh1", to: "agreement:p:ag2" },
    { id: "e3", type: "party_to", from: "stakeholder:p:sh1", to: "agreement:p:ag3" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps(edges);
  const findings = runProjectChecks({ nodes, edges }, outEdges, inEdges);
  assert.ok(!findings.some(f => f.rule === "stakeholder-overload"), "signed Agreements should not be counted");
});

// ──────────────────────────────────────────────────────────────
// P4: Resource gap
// ──────────────────────────────────────────────────────────────

test("P4: incomplete Task with no requires edge should trigger task-resource-gap WARN", () => {
  const nodes = [
    { id: "task:p:t1", type: "Task", title: "タスク1", summary: "s", state: "active" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps([]);
  const findings = runProjectChecks({ nodes, edges: [] }, outEdges, inEdges);
  assert.ok(findings.some(f => f.rule === "task-resource-gap"), "no requires edge should trigger WARN");
  const f = findings.find(f => f.rule === "task-resource-gap")!;
  assert.equal(f.severity, "WARN");
  assert.ok((f.details as string[]).some((d: string) => d.includes("t1")));
});

test("P4: completed / cancelled Tasks should be excluded", () => {
  const nodes = [
    { id: "task:p:t1", type: "Task", title: "完了", summary: "s", state: "completed" },
    { id: "task:p:t2", type: "Task", title: "中断", summary: "s", state: "cancelled" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps([]);
  const findings = runProjectChecks({ nodes, edges: [] }, outEdges, inEdges);
  assert.ok(!findings.some(f => f.rule === "task-resource-gap"), "completed/cancelled should be excluded");
});

test("P4: Task with requires edge should not trigger task-resource-gap", () => {
  const nodes = [
    { id: "task:p:t1", type: "Task", title: "タスク", summary: "s", state: "active" },
    { id: "resource:p:r1", type: "Resource", title: "リソース", summary: "s" },
  ];
  const edges = [
    { id: "e1", type: "requires", from: "task:p:t1", to: "resource:p:r1" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps(edges);
  const findings = runProjectChecks({ nodes, edges }, outEdges, inEdges);
  assert.ok(!findings.some(f => f.rule === "task-resource-gap"), "requires edge present → no WARN");
});

// ──────────────────────────────────────────────────────────────
// P5: Assumption orphan
// ──────────────────────────────────────────────────────────────

test("P5: Assumption not referenced by has_premise should trigger assumption-orphan WARN", () => {
  const nodes = [
    { id: "assumption:p:a1", type: "Assumption", title: "前提1", summary: "s", certainty: "Expected" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps([]);
  const findings = runProjectChecks({ nodes, edges: [] }, outEdges, inEdges);
  assert.ok(findings.some(f => f.rule === "assumption-orphan"), "isolated Assumption should trigger WARN");
  const f = findings.find(f => f.rule === "assumption-orphan")!;
  assert.equal(f.severity, "WARN");
  assert.ok((f.details as string[]).some((d: string) => d.includes("a1")));
});

test("P5: Assumption referenced by has_premise should not appear in assumption-orphan", () => {
  const nodes = [
    { id: "assumption:p:a1", type: "Assumption", title: "前提1", summary: "s", certainty: "Expected" },
    { id: "decision:p:d1", type: "Decision", title: "判断1", summary: "s" },
  ];
  const edges = [
    { id: "e1", type: "has_premise", from: "decision:p:d1", to: "assumption:p:a1" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps(edges);
  const findings = runProjectChecks({ nodes, edges }, outEdges, inEdges);
  assert.ok(!findings.some(f => f.rule === "assumption-orphan"), "referenced Assumption should not trigger WARN");
});

// ──────────────────────────────────────────────────────────────
// P6: Goal no-task
// ──────────────────────────────────────────────────────────────

test("P6: active Goal with no achieves edge should trigger goal-no-task WARN", () => {
  const nodes = [
    { id: "goal:p:g1", type: "Goal", title: "ゴール1", summary: "s", state: "active" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps([]);
  const findings = runProjectChecks({ nodes, edges: [] }, outEdges, inEdges);
  assert.ok(findings.some(f => f.rule === "goal-no-task"), "active Goal with no task should trigger WARN");
  const f = findings.find(f => f.rule === "goal-no-task")!;
  assert.equal(f.severity, "WARN");
  assert.ok((f.details as string[]).some((d: string) => d.includes("g1")));
});

test("P6: active Goal with achieves edge should not appear in goal-no-task", () => {
  const nodes = [
    { id: "goal:p:g1", type: "Goal", title: "ゴール1", summary: "s", state: "active" },
    { id: "task:p:t1", type: "Task", title: "タスク1", summary: "s", state: "active" },
  ];
  const edges = [
    { id: "e1", type: "achieves", from: "task:p:t1", to: "goal:p:g1" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps(edges);
  const findings = runProjectChecks({ nodes, edges }, outEdges, inEdges);
  assert.ok(!findings.some(f => f.rule === "goal-no-task"), "achieves edge present → no WARN");
});

test("P6: non-active Goals (planned / achieved / abandoned) should be excluded", () => {
  const nodes = [
    { id: "goal:p:g1", type: "Goal", title: "計画中", summary: "s", state: "planned" },
    { id: "goal:p:g2", type: "Goal", title: "達成済", summary: "s", state: "achieved" },
    { id: "goal:p:g3", type: "Goal", title: "放棄", summary: "s", state: "abandoned" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps([]);
  const findings = runProjectChecks({ nodes, edges: [] }, outEdges, inEdges);
  assert.ok(!findings.some(f => f.rule === "goal-no-task"), "non-active Goals should be excluded");
});

// ──────────────────────────────────────────────────────────────
// P7: Theme empty
// ──────────────────────────────────────────────────────────────

test("P7: Theme with 0 encompasses edges should trigger theme-empty WARN", () => {
  const nodes = [
    { id: "theme:p:th1", type: "Theme", title: "テーマ1", summary: "s" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps([]);
  const findings = runProjectChecks({ nodes, edges: [] }, outEdges, inEdges);
  assert.ok(findings.some(f => f.rule === "theme-empty"), "empty Theme should trigger WARN");
  const f = findings.find(f => f.rule === "theme-empty")!;
  assert.equal(f.severity, "WARN");
  assert.ok((f.details as string[]).some((d: string) => d.includes("th1")));
});

test("P7: Theme with encompasses edges should not appear in theme-empty", () => {
  const nodes = [
    { id: "theme:p:th1", type: "Theme", title: "テーマ1", summary: "s" },
    { id: "goal:p:g1", type: "Goal", title: "ゴール", summary: "s", state: "active" },
  ];
  const edges = [
    { id: "e1", type: "encompasses", from: "theme:p:th1", to: "goal:p:g1" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps(edges);
  const findings = runProjectChecks({ nodes, edges }, outEdges, inEdges);
  assert.ok(!findings.some(f => f.rule === "theme-empty"), "encompasses edge present → no WARN");
});

// ──────────────────────────────────────────────────────────────
// CLI integration: --schema project runs project checks
// ──────────────────────────────────────────────────────────────

test("CLI: passing --schema project should include [schema: project] label in output", () => {
  const graph = { nodes: [], edges: [] };
  const { out } = runWithSchema(graph);
  assert.match(out, /\[schema: project\]/);
});

test("CLI: without --schema project, project rules should not run", () => {
  // 2 exploring Agreements without --schema project should not trigger agreement-exploring-concentration
  const graph = {
    nodes: [
      { id: "agreement:p:ag1", type: "Agreement", title: "A1", summary: "s", state: "exploring" },
      { id: "agreement:p:ag2", type: "Agreement", title: "A2", summary: "s", state: "exploring" },
    ],
    edges: [],
  };
  const dir = mkdtempSync(path.join(tmpdir(), "cc-proj-"));
  const gp = path.join(dir, "graph.json");
  writeFileSync(gp, JSON.stringify(graph));
  let out: string;
  try {
    out = execFileSync("node", ["--experimental-strip-types", CLI, "--graph", gp], { encoding: "utf8" });
  } catch (e: any) {
    out = String(e.stdout ?? "");
  }
  assert.doesNotMatch(out, /agreement-exploring-concentration/, "without --schema, project rules should not run");
});

test("CLI: clean project vault with --schema project should not trigger any project rule WARNs", () => {
  // Agreement: active (no exploring/negotiating) / Stakeholder: party_to 2 edges /
  // Task: 1 with requires / Assumption: has_premise present /
  // Goal: achieves present / Theme: encompasses present
  const graph = {
    nodes: [
      { id: "stakeholder:p:sh1", type: "Stakeholder", title: "SH", summary: "s" },
      { id: "agreement:p:ag1", type: "Agreement", title: "AG", summary: "s", state: "active" },
      { id: "agreement:p:ag2", type: "Agreement", title: "AG2", summary: "s", state: "active" },
      { id: "task:p:t1", type: "Task", title: "T1", summary: "s", state: "active" },
      { id: "resource:p:r1", type: "Resource", title: "R1", summary: "s" },
      { id: "assumption:p:a1", type: "Assumption", title: "A1", summary: "s", certainty: "Expected" },
      { id: "goal:p:g1", type: "Goal", title: "G1", summary: "s", state: "active" },
      { id: "theme:p:th1", type: "Theme", title: "TH1", summary: "s" },
      { id: "decision:p:d1", type: "Decision", title: "D1", summary: "s" },
    ],
    edges: [
      { id: "e1", type: "party_to", from: "stakeholder:p:sh1", to: "agreement:p:ag1" },
      { id: "e2", type: "party_to", from: "stakeholder:p:sh1", to: "agreement:p:ag2" },
      { id: "e3", type: "requires", from: "task:p:t1", to: "resource:p:r1" },
      { id: "e4", type: "has_premise", from: "decision:p:d1", to: "assumption:p:a1" },
      { id: "e5", type: "achieves", from: "task:p:t1", to: "goal:p:g1" },
      { id: "e6", type: "encompasses", from: "theme:p:th1", to: "goal:p:g1" },
    ],
  };
  const { out } = runWithSchema(graph);
  assert.doesNotMatch(out, /agreement-exploring-concentration/);
  assert.doesNotMatch(out, /agreement-negotiating-stagnation/);
  assert.doesNotMatch(out, /stakeholder-overload/);
  assert.doesNotMatch(out, /task-resource-gap/);
  assert.doesNotMatch(out, /assumption-orphan/);
  assert.doesNotMatch(out, /goal-no-task/);
  assert.doesNotMatch(out, /theme-empty/);
});
