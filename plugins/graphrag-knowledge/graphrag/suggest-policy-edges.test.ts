import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  suggestBindingsForNodes,
  suggestRelationsForNodes,
  BINDING_EDGE_TYPE_BY_NODE,
  main,
} from "./suggest-policy-edges.ts";
import { RELATION_BAND_LOW, RELATION_BAND_HIGH } from "./duplicate-check.ts";

// File 行を持つ偽索引。impl File (docs/knowhow/plans/design-decisions 以外) のみ候補対象。
const indexWith = (...rows: any[]) => ({ rows });
const embedConst = (vector: number[]) => async () => vector;

test("提案エッジ型は知識型ごとに固定 (契約 E0)", () => {
  assert.equal(BINDING_EDGE_TYPE_BY_NODE.Decision, "sets_policy_for");
  assert.equal(BINDING_EDGE_TYPE_BY_NODE.Risk, "risks_in");
  assert.equal(BINDING_EDGE_TYPE_BY_NODE.OperationalKnowledge, "documented_by");
  assert.equal(BINDING_EDGE_TYPE_BY_NODE.Constraint, "constrains");
});

test("Decision の binding 候補は sets_policy_for・閾値以上の File を similarity 降順で", async () => {
  const out = await suggestBindingsForNodes({
    vectorIndex: indexWith(
      { node_id: "file:s:src/a.ts", vector: [1, 0, 0], path: "src/a.ts" },
      { node_id: "file:s:src/b.ts", vector: [0.8, 0.6, 0], path: "src/b.ts" }
    ),
    nodes: [{ id: "decision:s:d", type: "Decision", title: "D", summary: "x" }],
    embed: embedConst([1, 0, 0]),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].edge_type, "sets_policy_for");
  assert.equal(out[0].candidates[0].file_id, "file:s:src/a.ts", "cosine 1.0 が先頭");
  assert.ok(out[0].candidates[0].similarity >= out[0].candidates[1].similarity);
  // そのまま実行できる確定手段: commit-mutation に貼れる plan_fragment (再 add-* は
  // node already exists で失敗するため example 形式は廃止) + 作成前用の verb/flag。
  const apply = out[0].candidates[0].apply;
  assert.equal(apply.verb, "add-decision");
  assert.equal(apply.flag, "--sets-policy-for");
  assert.deepEqual(apply.plan_fragment, {
    op: "create",
    id: "decision_s_d__sets_policy_for__file_s_src/a.ts",
    type: "sets_policy_for",
    from: "decision:s:d",
    to: "file:s:src/a.ts",
  });
});

test("apply.plan_fragment: OK は documented_by エッジ + 作成前 CLI フラグは --evidence (実在フラグ)", async () => {
  const out = await suggestBindingsForNodes({
    vectorIndex: indexWith({ node_id: "file:s:src/a.ts", vector: [1, 0, 0], path: "src/a.ts" }),
    nodes: [{ id: "ok:s:o", type: "OperationalKnowledge", title: "O", summary: "x" }],
    embed: embedConst([1, 0, 0]),
  });
  const apply = out[0].candidates[0].apply;
  assert.equal(apply.verb, "add-ok");
  assert.equal(apply.flag, "--evidence", "add-ok に --documented-by は存在しない (documented_by は --evidence が担う)");
  assert.equal(apply.plan_fragment.type, "documented_by");
  assert.equal(apply.plan_fragment.id, "ok_s_o__documented_by__file_s_src/a.ts");
});

test("型別固定: Risk→risks_in / OK→documented_by / Constraint→constrains", async () => {
  const idx = indexWith({ node_id: "file:s:src/a.ts", vector: [1, 0, 0], path: "src/a.ts" });
  const embed = embedConst([1, 0, 0]);
  const risk = await suggestBindingsForNodes({
    vectorIndex: idx,
    nodes: [{ id: "risk:s:r", type: "Risk", title: "R", summary: "x" }],
    embed,
  });
  const ok = await suggestBindingsForNodes({
    vectorIndex: idx,
    nodes: [{ id: "ok:s:o", type: "OperationalKnowledge", title: "O", summary: "x" }],
    embed,
  });
  const con = await suggestBindingsForNodes({
    vectorIndex: idx,
    nodes: [{ id: "constraint:s:c", type: "Constraint", title: "C", summary: "x" }],
    embed,
  });
  assert.equal(risk[0].edge_type, "risks_in");
  assert.equal(ok[0].edge_type, "documented_by");
  assert.equal(con[0].edge_type, "constrains");
});

test("閾値 (0.7) 未満の File は候補に出ない", async () => {
  const out = await suggestBindingsForNodes({
    vectorIndex: indexWith({ node_id: "file:s:src/a.ts", vector: [0, 1, 0], path: "src/a.ts" }),
    nodes: [{ id: "decision:s:d", type: "Decision", title: "D", summary: "x" }],
    embed: embedConst([1, 0, 0]), // 直交 = cosine 0
  });
  assert.deepEqual(out, [], "近接 File 無しのノードは列挙しない");
});

test("docs/knowhow/plans/design-decisions の File は出所扱いで候補から除外", async () => {
  const out = await suggestBindingsForNodes({
    vectorIndex: indexWith({
      node_id: "file:s:docs/knowhow/x.md",
      vector: [1, 0, 0],
      path: "docs/knowhow/x.md",
    }),
    nodes: [{ id: "decision:s:d", type: "Decision", title: "D", summary: "x" }],
    embed: embedConst([1, 0, 0]),
  });
  assert.deepEqual(out, [], "doc File は impl binding 候補ではない");
});

test("対象外型 (Goal 等) は binding 提案しない", async () => {
  const out = await suggestBindingsForNodes({
    vectorIndex: indexWith({ node_id: "file:s:src/a.ts", vector: [1, 0, 0], path: "src/a.ts" }),
    nodes: [{ id: "goal:s:g", type: "Goal", title: "G", summary: "x" }],
    embed: embedConst([1, 0, 0]),
  });
  assert.deepEqual(out, []);
});

test("File 行が無い索引は空 (skip)・embed を呼ばない", async () => {
  let calls = 0;
  const out = await suggestBindingsForNodes({
    vectorIndex: indexWith({ node_id: "decision:s:other", vector: [1, 0, 0] }), // File 行ゼロ
    nodes: [{ id: "decision:s:d", type: "Decision", title: "D", summary: "x" }],
    embed: async () => {
      calls += 1;
      return [1, 0, 0];
    },
  });
  assert.deepEqual(out, []);
  assert.equal(calls, 0, "File 行が無ければ埋め込みもしない");
});

test("index 不在 (null) は空配列で skip", async () => {
  const out = await suggestBindingsForNodes({
    vectorIndex: null,
    nodes: [{ id: "decision:s:d", type: "Decision", title: "D", summary: "x" }],
    embed: embedConst([1, 0, 0]),
  });
  assert.deepEqual(out, []);
});

test("非正規化ベクトルでも真の cosine で判定 (両ノルムで割る)", async () => {
  const out = await suggestBindingsForNodes({
    vectorIndex: indexWith({ node_id: "file:s:src/a.ts", vector: [5, 0, 0], path: "src/a.ts" }),
    nodes: [{ id: "decision:s:d", type: "Decision", title: "D", summary: "x" }],
    embed: embedConst([2, 0, 0]), // 方向一致 = cosine 1.0
  });
  assert.equal(out[0].candidates[0].similarity, 1);
});

test("alias 型 (Concern 等は対象外。canonical 知識型のみ提案)", async () => {
  // Concern は binding 対象型 (D/OK/R/Constraint) ではないので提案しない。
  const out = await suggestBindingsForNodes({
    vectorIndex: indexWith({ node_id: "file:s:src/a.ts", vector: [1, 0, 0], path: "src/a.ts" }),
    nodes: [{ id: "concern:s:c", type: "Concern", title: "C", summary: "x" }],
    embed: embedConst([1, 0, 0]),
  });
  assert.deepEqual(out, []);
});

// ── main 経由 (binding モード): graph/vector を temp に書いて起動し stdout を捕まえる ──
function runMain(graph: any, vector: any, extraArgs: string[]): any {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spe-"));
  const gp = path.join(dir, "graph.json");
  const vp = path.join(dir, "vector.json");
  fs.writeFileSync(gp, JSON.stringify(graph));
  fs.writeFileSync(vp, JSON.stringify(vector));
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (s: any) => { lines.push(String(s)); };
  console.error = () => {};
  try {
    main(["--graph", gp, "--vector-index", vp, ...extraArgs]);
  } finally {
    console.log = origLog;
    console.error = origErr;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return JSON.parse(lines.join("\n"));
}

test("binding モード: Constraint が候補に出る + edge_type=constrains を含む", () => {
  const graph = {
    nodes: [
      { id: "constraint:s:c", type: "Constraint", title: "C", summary: "policy" },
      { id: "file:s:src/a.ts", type: "File", title: "a", path: "src/a.ts" },
    ],
    edges: [],
  };
  const vector = {
    rows: [
      { node_id: "constraint:s:c", vector: [1, 0, 0] },
      { node_id: "file:s:src/a.ts", vector: [1, 0, 0] },
    ],
  };
  const res = runMain(graph, vector, []);
  assert.equal(res.suggestion_count, 1);
  assert.equal(res.suggestions[0].knowledge_type, "Constraint");
  assert.equal(res.suggestions[0].edge_type, "constrains");
  assert.equal(res.suggestions[0].top_candidates[0].file_id, "file:s:src/a.ts");
});

test("binding モード --missing-only: constrains を 1 本でも持つ Constraint は skip", () => {
  const graph = {
    nodes: [
      { id: "constraint:s:bound", type: "Constraint", title: "Bound", summary: "x" },
      { id: "constraint:s:free", type: "Constraint", title: "Free", summary: "x" },
      { id: "file:s:src/a.ts", type: "File", title: "a", path: "src/a.ts" },
      { id: "decision:s:d", type: "Decision", title: "D", summary: "x" },
    ],
    // bound は constrains を 1 本持つ (宛先は File でなくてもよい = check-carving 同定義)
    edges: [{ from: "constraint:s:bound", to: "decision:s:d", type: "constrains" }],
  };
  const vector = {
    rows: [
      { node_id: "constraint:s:bound", vector: [1, 0, 0] },
      { node_id: "constraint:s:free", vector: [1, 0, 0] },
      { node_id: "file:s:src/a.ts", vector: [1, 0, 0] },
      { node_id: "decision:s:d", vector: [0, 1, 0] },
    ],
  };
  const res = runMain(graph, vector, ["--missing-only"]);
  const ids = res.suggestions.map((s: any) => s.knowledge_id);
  assert.ok(!ids.includes("constraint:s:bound"), "constrains 持ちは skip");
  assert.ok(ids.includes("constraint:s:free"), "constrains 無しは出る");
});

test("binding モード: D/OK/R の挙動は不変 (edge_type 付与・missing-only 従来定義)", () => {
  const graph = {
    nodes: [
      { id: "decision:s:bound", type: "Decision", title: "Db", summary: "x" },
      { id: "decision:s:free", type: "Decision", title: "Df", summary: "x" },
      { id: "file:s:src/a.ts", type: "File", title: "a", path: "src/a.ts" },
    ],
    // bound は sets_policy_for が実装 File 宛 → 従来定義で binding 済み
    edges: [{ from: "decision:s:bound", to: "file:s:src/a.ts", type: "sets_policy_for" }],
  };
  const vector = {
    rows: [
      { node_id: "decision:s:bound", vector: [1, 0, 0] },
      { node_id: "decision:s:free", vector: [1, 0, 0] },
      { node_id: "file:s:src/a.ts", vector: [1, 0, 0] },
    ],
  };
  const all = runMain(graph, vector, []);
  for (const s of all.suggestions) {
    assert.equal(s.edge_type, "sets_policy_for", "Decision の edge_type は sets_policy_for");
  }
  const missing = runMain(graph, vector, ["--missing-only"]);
  const ids = missing.suggestions.map((s: any) => s.knowledge_id);
  assert.ok(!ids.includes("decision:s:bound"), "実装 File 宛 sets_policy_for 済みは skip");
  assert.ok(ids.includes("decision:s:free"), "未紐付けは出る");
});

// ── relations モード (知識↔知識) ───────────────────────────────────────────
test("relations: 帯域 [0.80, 0.92) のペアだけ返す (0.79 と 0.92 は出ない)", () => {
  // 同型 (Decision) で意図的に cosine 0.79 / 0.85 / 0.92 を作る。
  // [cos, sin] 単位ベクトルで角度から cosine を作る。
  const unit = (c: number) => [c, Math.sqrt(1 - c * c)];
  const nodes = [
    { id: "decision:s:base", type: "Decision", title: "base" },
    { id: "decision:s:c79", type: "Decision", title: "c79" },
    { id: "decision:s:c85", type: "Decision", title: "c85" },
    { id: "decision:s:c92", type: "Decision", title: "c92" },
  ];
  const embById = new Map<string, number[]>([
    ["decision:s:base", [1, 0]],
    ["decision:s:c79", unit(0.79)],
    ["decision:s:c85", unit(0.85)],
    ["decision:s:c92", unit(RELATION_BAND_HIGH)],
  ]);
  const normById = new Map<string, number>(
    [...embById.entries()].map(([k, v]) => [k, Math.sqrt(v[0] * v[0] + v[1] * v[1])])
  );
  const pairs = suggestRelationsForNodes({ nodes, embById, normById });
  const sims = pairs
    .filter((p) => p.a_id === "decision:s:base" || p.b_id === "decision:s:base")
    .map((p) => p.similarity);
  // base×c85 のみが帯域内 (0.79 は下限未満 / 0.92 は上限以上で除外)
  assert.deepEqual(sims, [0.85]);
  assert.ok(RELATION_BAND_LOW === 0.8 && RELATION_BAND_HIGH === 0.92);
});

test("relations: 異型ペアは照合しない (Decision×Risk は出ない)", () => {
  const embById = new Map<string, number[]>([
    ["decision:s:d", [1, 0]],
    ["risk:s:r", [1, 0]], // 完全一致だが型が違う
  ]);
  const normById = new Map<string, number>([
    ["decision:s:d", 1],
    ["risk:s:r", 1],
  ]);
  const pairs = suggestRelationsForNodes({
    nodes: [
      { id: "decision:s:d", type: "Decision", title: "D" },
      { id: "risk:s:r", type: "Risk", title: "R" },
    ],
    embById,
    normById,
  });
  assert.deepEqual(pairs, []);
});

test("relations モード main: mode/pairs/pair_count・similarity 降順・note 形", () => {
  const unit = (c: number) => [c, Math.sqrt(1 - c * c)];
  const graph = {
    nodes: [
      { id: "decision:s:a", type: "Decision", title: "A" },
      { id: "decision:s:b", type: "Decision", title: "B" },
    ],
    edges: [],
  };
  const vector = {
    rows: [
      { node_id: "decision:s:a", vector: [1, 0] },
      { node_id: "decision:s:b", vector: unit(0.85) },
    ],
  };
  const res = runMain(graph, vector, ["--relations"]);
  assert.equal(res.mode, "relations");
  assert.equal(res.pair_count, 1);
  assert.equal(res.pairs[0].a_id && res.pairs[0].b_id ? true : false, true);
  assert.match(res.pairs[0].note, /refines/);
  assert.match(res.pairs[0].note, /supersede/);
});
