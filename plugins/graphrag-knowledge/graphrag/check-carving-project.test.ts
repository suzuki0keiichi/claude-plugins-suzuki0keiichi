// check-carving project vault checks (P1–P7)
//
// runProjectChecks() の単体テストと、--schema project CLI 統合テスト。
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
// P1: Agreement exploring 集中
// ──────────────────────────────────────────────────────────────

test("P1: exploring Agreement が 2 件以上かつ responsible_for 無しなら agreement-exploring-concentration WARN", () => {
  const nodes = [
    { id: "agreement:p:ag1", type: "Agreement", title: "合意1", summary: "s", state: "exploring" },
    { id: "agreement:p:ag2", type: "Agreement", title: "合意2", summary: "s", state: "exploring" },
  ];
  const edges: any[] = [];
  const { outEdges, inEdges } = buildEdgeMaps(edges);
  const findings = runProjectChecks({ nodes, edges }, outEdges, inEdges);
  const rules = findings.map(f => f.rule);
  assert.ok(rules.includes("agreement-exploring-concentration"), "2件担当者無しで WARN が出るべき");
  const f = findings.find(f => f.rule === "agreement-exploring-concentration")!;
  assert.equal(f.severity, "WARN");
});

test("P1: exploring Agreement が 1 件のみなら agreement-exploring-concentration は出ない", () => {
  const nodes = [
    { id: "agreement:p:ag1", type: "Agreement", title: "合意1", summary: "s", state: "exploring" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps([]);
  const findings = runProjectChecks({ nodes, edges: [] }, outEdges, inEdges);
  assert.ok(!findings.some(f => f.rule === "agreement-exploring-concentration"), "1件ならWARN不要");
});

test("P1: responsible_for が付いている exploring Agreement はカウントから除外される", () => {
  // ag1 には responsible_for あり、ag2 には無し → 1 件のみ → WARN 出ない
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
  // ag1 は responsible_for あり → 担当者無しは ag2 の 1 件のみ → WARN しない
  assert.ok(!findings.some(f => f.rule === "agreement-exploring-concentration"),
    "担当者有りが 1 件あるので担当者無しは 1 件 → WARN 不要");
});

// ──────────────────────────────────────────────────────────────
// P2: Agreement negotiating 滞留
// ──────────────────────────────────────────────────────────────

test("P2: state=negotiating の Agreement があれば agreement-negotiating-stagnation WARN", () => {
  const nodes = [
    { id: "agreement:p:ag1", type: "Agreement", title: "交渉中", summary: "s", state: "negotiating" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps([]);
  const findings = runProjectChecks({ nodes, edges: [] }, outEdges, inEdges);
  assert.ok(findings.some(f => f.rule === "agreement-negotiating-stagnation"), "negotiating で WARN");
  const f = findings.find(f => f.rule === "agreement-negotiating-stagnation")!;
  assert.equal(f.severity, "WARN");
  assert.ok(f.details && (f.details as string[]).some((d: string) => d.includes("ag1")), "details に ag1 が出る");
});

test("P2: negotiating が 0 件なら agreement-negotiating-stagnation は出ない", () => {
  const nodes = [
    { id: "agreement:p:ag1", type: "Agreement", title: "合意", summary: "s", state: "active" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps([]);
  const findings = runProjectChecks({ nodes, edges: [] }, outEdges, inEdges);
  assert.ok(!findings.some(f => f.rule === "agreement-negotiating-stagnation"));
});

// ──────────────────────────────────────────────────────────────
// P3: Stakeholder 過負荷
// ──────────────────────────────────────────────────────────────

test("P3: Stakeholder が active Agreement に 3 件 party_to していたら stakeholder-overload WARN", () => {
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
  assert.ok(findings.some(f => f.rule === "stakeholder-overload"), "3件で WARN");
  const f = findings.find(f => f.rule === "stakeholder-overload")!;
  assert.equal(f.severity, "WARN");
  assert.ok(f.message.includes("sh1") || (f.details as string[]).some((d: string) => d.includes("sh1")));
});

test("P3: 2 件の active Agreement では stakeholder-overload は出ない", () => {
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
  assert.ok(!findings.some(f => f.rule === "stakeholder-overload"), "2件なら WARN 不要");
});

test("P3: party_to 先が active でない Agreement はカウントしない", () => {
  // 3件 party_to だが 1 件は signed → active カウントは 2 → WARN なし
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
  assert.ok(!findings.some(f => f.rule === "stakeholder-overload"), "signed はカウントしない");
});

// ──────────────────────────────────────────────────────────────
// P4: Resource gap
// ──────────────────────────────────────────────────────────────

test("P4: 未完了 Task に requires エッジが無ければ task-resource-gap WARN", () => {
  const nodes = [
    { id: "task:p:t1", type: "Task", title: "タスク1", summary: "s", state: "active" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps([]);
  const findings = runProjectChecks({ nodes, edges: [] }, outEdges, inEdges);
  assert.ok(findings.some(f => f.rule === "task-resource-gap"), "requires 無しで WARN");
  const f = findings.find(f => f.rule === "task-resource-gap")!;
  assert.equal(f.severity, "WARN");
  assert.ok((f.details as string[]).some((d: string) => d.includes("t1")));
});

test("P4: completed / cancelled Task は対象外", () => {
  const nodes = [
    { id: "task:p:t1", type: "Task", title: "完了", summary: "s", state: "completed" },
    { id: "task:p:t2", type: "Task", title: "中断", summary: "s", state: "cancelled" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps([]);
  const findings = runProjectChecks({ nodes, edges: [] }, outEdges, inEdges);
  assert.ok(!findings.some(f => f.rule === "task-resource-gap"), "completed/cancelled は対象外");
});

test("P4: requires エッジがあれば task-resource-gap は出ない", () => {
  const nodes = [
    { id: "task:p:t1", type: "Task", title: "タスク", summary: "s", state: "active" },
    { id: "resource:p:r1", type: "Resource", title: "リソース", summary: "s" },
  ];
  const edges = [
    { id: "e1", type: "requires", from: "task:p:t1", to: "resource:p:r1" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps(edges);
  const findings = runProjectChecks({ nodes, edges }, outEdges, inEdges);
  assert.ok(!findings.some(f => f.rule === "task-resource-gap"), "requires あれば WARN なし");
});

// ──────────────────────────────────────────────────────────────
// P5: Assumption orphan
// ──────────────────────────────────────────────────────────────

test("P5: has_premise で参照されていない Assumption は assumption-orphan WARN", () => {
  const nodes = [
    { id: "assumption:p:a1", type: "Assumption", title: "前提1", summary: "s", certainty: "Expected" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps([]);
  const findings = runProjectChecks({ nodes, edges: [] }, outEdges, inEdges);
  assert.ok(findings.some(f => f.rule === "assumption-orphan"), "孤立 Assumption で WARN");
  const f = findings.find(f => f.rule === "assumption-orphan")!;
  assert.equal(f.severity, "WARN");
  assert.ok((f.details as string[]).some((d: string) => d.includes("a1")));
});

test("P5: has_premise で参照されている Assumption は assumption-orphan に出ない", () => {
  const nodes = [
    { id: "assumption:p:a1", type: "Assumption", title: "前提1", summary: "s", certainty: "Expected" },
    { id: "decision:p:d1", type: "Decision", title: "判断1", summary: "s" },
  ];
  const edges = [
    { id: "e1", type: "has_premise", from: "decision:p:d1", to: "assumption:p:a1" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps(edges);
  const findings = runProjectChecks({ nodes, edges }, outEdges, inEdges);
  assert.ok(!findings.some(f => f.rule === "assumption-orphan"), "参照ありなら WARN 不要");
});

// ──────────────────────────────────────────────────────────────
// P6: Goal 未着手
// ──────────────────────────────────────────────────────────────

test("P6: active Goal に achieves エッジが届いていなければ goal-no-task WARN", () => {
  const nodes = [
    { id: "goal:p:g1", type: "Goal", title: "ゴール1", summary: "s", state: "active" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps([]);
  const findings = runProjectChecks({ nodes, edges: [] }, outEdges, inEdges);
  assert.ok(findings.some(f => f.rule === "goal-no-task"), "active Goal 未着手で WARN");
  const f = findings.find(f => f.rule === "goal-no-task")!;
  assert.equal(f.severity, "WARN");
  assert.ok((f.details as string[]).some((d: string) => d.includes("g1")));
});

test("P6: achieves エッジが届いている active Goal は goal-no-task に出ない", () => {
  const nodes = [
    { id: "goal:p:g1", type: "Goal", title: "ゴール1", summary: "s", state: "active" },
    { id: "task:p:t1", type: "Task", title: "タスク1", summary: "s", state: "active" },
  ];
  const edges = [
    { id: "e1", type: "achieves", from: "task:p:t1", to: "goal:p:g1" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps(edges);
  const findings = runProjectChecks({ nodes, edges }, outEdges, inEdges);
  assert.ok(!findings.some(f => f.rule === "goal-no-task"), "achieves あれば WARN なし");
});

test("P6: active 以外 (planned / achieved / abandoned) の Goal は対象外", () => {
  const nodes = [
    { id: "goal:p:g1", type: "Goal", title: "計画中", summary: "s", state: "planned" },
    { id: "goal:p:g2", type: "Goal", title: "達成済", summary: "s", state: "achieved" },
    { id: "goal:p:g3", type: "Goal", title: "放棄", summary: "s", state: "abandoned" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps([]);
  const findings = runProjectChecks({ nodes, edges: [] }, outEdges, inEdges);
  assert.ok(!findings.some(f => f.rule === "goal-no-task"), "非 active Goal は対象外");
});

// ──────────────────────────────────────────────────────────────
// P7: Theme 空
// ──────────────────────────────────────────────────────────────

test("P7: encompasses エッジが 0 本の Theme は theme-empty WARN", () => {
  const nodes = [
    { id: "theme:p:th1", type: "Theme", title: "テーマ1", summary: "s" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps([]);
  const findings = runProjectChecks({ nodes, edges: [] }, outEdges, inEdges);
  assert.ok(findings.some(f => f.rule === "theme-empty"), "空テーマで WARN");
  const f = findings.find(f => f.rule === "theme-empty")!;
  assert.equal(f.severity, "WARN");
  assert.ok((f.details as string[]).some((d: string) => d.includes("th1")));
});

test("P7: encompasses エッジがある Theme は theme-empty に出ない", () => {
  const nodes = [
    { id: "theme:p:th1", type: "Theme", title: "テーマ1", summary: "s" },
    { id: "goal:p:g1", type: "Goal", title: "ゴール", summary: "s", state: "active" },
  ];
  const edges = [
    { id: "e1", type: "encompasses", from: "theme:p:th1", to: "goal:p:g1" },
  ];
  const { outEdges, inEdges } = buildEdgeMaps(edges);
  const findings = runProjectChecks({ nodes, edges }, outEdges, inEdges);
  assert.ok(!findings.some(f => f.rule === "theme-empty"), "encompasses あれば WARN なし");
});

// ──────────────────────────────────────────────────────────────
// CLI 統合: --schema project で project チェックが実行される
// ──────────────────────────────────────────────────────────────

test("CLI: --schema project を渡すと [schema: project] ラベルが出力に含まれる", () => {
  const graph = { nodes: [], edges: [] };
  const { out } = runWithSchema(graph);
  assert.match(out, /\[schema: project\]/);
});

test("CLI: --schema project なしでは project ルールは実行されない", () => {
  // exploring Agreement が 2 件あっても --schema project が無ければ agreement-exploring-concentration は出ない
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
  assert.doesNotMatch(out, /agreement-exploring-concentration/, "--schema 無しでは project ルールは動かない");
});

test("CLI: --schema project で clean な project vault は project ルール WARN が出ない", () => {
  // Agreement: active (exploring/negotiating なし) / Stakeholder: party_to 2件 /
  // Task: 1件で requires あり / Assumption: has_premise あり /
  // Goal: achieves あり / Theme: encompasses あり
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
