import assert from "node:assert/strict";
import test from "node:test";
import { validateMutation, applyMutationToGraph, normalizeMutationPlan } from "./mutation-core.ts";

const baseGraph = () => ({
  nodes: [
    { id: "decision:s:a", type: "Decision", title: "A", summary: "a" },
    { id: "decision:s:b", type: "Decision", title: "B", summary: "b" },
  ],
  edges: [
    { id: "e1", type: "refines", from: "decision:s:a", to: "decision:s:b" },
  ],
});

test("付け替え: refines の to を b→a 以外へ更新すると next に反映", () => {
  const plan = { reason: "repoint", nodes: [], edges: [
    { op: "update", id: "e1", type: "refines", from: "decision:s:a", to: "decision:s:b" },
  ]};
  const v = validateMutation({ currentGraph: baseGraph(), plan });
  assert.equal(v.valid, true, v.failures.join("; "));
});

test("宙ぶらりんエッジを作る create は拒否", () => {
  const plan = { reason: "dangling", nodes: [], edges: [
    { op: "create", id: "e2", type: "refines", from: "decision:s:a", to: "decision:s:MISSING" },
  ]};
  const v = validateMutation({ currentGraph: baseGraph(), plan });
  assert.equal(v.valid, false);
  assert.ok(v.failures.some((f) => f.includes("missing to node")));
});

test("node 削除は DETACH カスケードで関連 edge を落とし audit に記録", () => {
  const plan = { reason: "del", nodes: [{ op: "delete", id: "decision:s:b" }], edges: [] };
  const v = validateMutation({ currentGraph: baseGraph(), plan });
  assert.equal(v.valid, true, v.failures.join("; "));
  assert.ok(!v.nextGraph.edges.some((e) => e.id === "e1"), "e1 should cascade");
  assert.deepEqual(v.cascadedEdgeIds, ["e1"]);
});

test("duplicate_ack は正規化後の plan に保持され、未指定は空配列", () => {
  const node = { op: "create", id: "decision:s:c", type: "Decision", title: "C" };
  const withAck = normalizeMutationPlan({
    reason: "r",
    nodes: [node],
    edges: [],
    duplicate_ack: ["decision:s:a", "decision:s:b"],
  });
  assert.deepEqual(withAck.duplicate_ack, ["decision:s:a", "decision:s:b"]);
  const withoutAck = normalizeMutationPlan({ reason: "r", nodes: [node], edges: [] });
  assert.deepEqual(withoutAck.duplicate_ack, []);
});

test("duplicate_ack が文字列配列でなければ明示エラー (黙って落として reject させない)", () => {
  const node = { op: "create", id: "decision:s:c", type: "Decision", title: "C" };
  assert.throws(
    () => normalizeMutationPlan({ nodes: [node], edges: [], duplicate_ack: "decision:s:a" }),
    /duplicate_ack/
  );
  assert.throws(
    () => normalizeMutationPlan({ nodes: [node], edges: [], duplicate_ack: [1, 2] }),
    /duplicate_ack/
  );
});

test("updates の null はフィールド削除を意味する (state 取り下げで frontmatter に null を残さない)", () => {
  const graph = {
    nodes: [{ id: "decision:s:a", type: "Decision", title: "A", state: "superseded", summary: "s" }],
    edges: []
  };
  const plan = normalizeMutationPlan({
    reason: "r",
    nodes: [{ op: "update", id: "decision:s:a", updates: { state: null } }],
    edges: []
  });
  const next = applyMutationToGraph(graph, plan);
  const node = next.nodes.find((n) => n.id === "decision:s:a");
  assert.ok(!("state" in node), "state キー自体が消えること (null 残置は不可)");
  assert.equal(node.summary, "s", "他フィールドは保持");
});

test("update が触らない既存 null フィールドも merge 時に掃除される", () => {
  const graph = {
    nodes: [{ id: "decision:s:a", type: "Decision", title: "A", state: null }],
    edges: []
  };
  const plan = normalizeMutationPlan({
    reason: "r",
    nodes: [{ op: "update", id: "decision:s:a", updates: { summary: "new" } }],
    edges: []
  });
  const next = applyMutationToGraph(graph, plan);
  const node = next.nodes.find((n) => n.id === "decision:s:a");
  assert.ok(!("state" in node), "legacy の state:null は触ったノードから掃除される");
  assert.equal(node.summary, "new");
});

test("create に null フィールドがあればキーごと落とす", () => {
  const plan = normalizeMutationPlan({
    reason: "r",
    nodes: [{ op: "create", id: "decision:s:b", type: "Decision", title: "B", state: null }],
    edges: []
  });
  const next = applyMutationToGraph({ nodes: [], edges: [] }, plan);
  const node = next.nodes.find((n) => n.id === "decision:s:b");
  assert.ok(!("state" in node));
});

// ── op:update の generated_at 更新 (staleness 収束) ──────────────────────────

test("op:update は generated_at を now に進める (再検証の刻印。staleness の起点が進む)", () => {
  const graph = {
    nodes: [
      { id: "n1", type: "Decision", title: "T", generated_at: "2020-01-01T00:00:00.000Z" },
      { id: "n2", type: "Decision", title: "U", generated_at: "2020-01-01T00:00:00.000Z" },
    ],
    edges: [],
  };
  const plan = normalizeMutationPlan({
    nodes: [{ op: "update", id: "n1", updates: { summary: "re-verified" } }],
  });
  const before = Date.now() - 1000;
  const next = applyMutationToGraph(graph, plan);
  const updated = next.nodes.find((n) => n.id === "n1");
  assert.notEqual(updated.generated_at, "2020-01-01T00:00:00.000Z");
  assert.ok(Date.parse(updated.generated_at) >= before, "now に更新される");
  // 触っていないノードは据え置き (unrelated files must not churn)
  const untouched = next.nodes.find((n) => n.id === "n2");
  assert.equal(untouched.generated_at, "2020-01-01T00:00:00.000Z");
});

test("op:update で plan が generated_at を明示した場合はそれを尊重する", () => {
  const graph = {
    nodes: [{ id: "n1", type: "Decision", title: "T", generated_at: "2020-01-01T00:00:00.000Z" }],
    edges: [],
  };
  const plan = normalizeMutationPlan({
    nodes: [{ op: "update", id: "n1", updates: { generated_at: "2024-06-01T00:00:00.000Z" } }],
  });
  const next = applyMutationToGraph(graph, plan);
  assert.equal(next.nodes[0].generated_at, "2024-06-01T00:00:00.000Z");
});

test("op:update が既存値と同一の patch は node を byte-identical に保ち generated_at も進めない (replay 冪等性)", () => {
  const graph = {
    nodes: [{ id: "n1", type: "Decision", title: "T", summary: "same", generated_at: "2020-01-01T00:00:00.000Z" }],
    edges: [],
  };
  const plan = normalizeMutationPlan({
    nodes: [{ op: "update", id: "n1", updates: { summary: "same" } }],
  });
  const next = applyMutationToGraph(graph, plan);
  assert.deepEqual(next.nodes[0], graph.nodes[0], "無変更 patch は node を全く変えない");

  // 同一 plan を再適用しても結果は変わらない (再試行/no-op replay で内容が動かない)
  const replay = applyMutationToGraph(next, plan);
  assert.deepEqual(replay.nodes[0], next.nodes[0], "同一 plan の再適用は冪等");
});

test("op:update が明示的に generated_at を指定した場合、他フィールドが無変更でもその値を適用する", () => {
  const graph = {
    nodes: [{ id: "n1", type: "Decision", title: "T", summary: "same", generated_at: "2020-01-01T00:00:00.000Z" }],
    edges: [],
  };
  const plan = normalizeMutationPlan({
    nodes: [{ op: "update", id: "n1", updates: { summary: "same", generated_at: "2024-06-01T00:00:00.000Z" } }],
  });
  const next = applyMutationToGraph(graph, plan);
  assert.equal(next.nodes[0].generated_at, "2024-06-01T00:00:00.000Z", "明示された再検証スタンプは他が無変更でも尊重される");
});

// ── issue #18: 参照同一性 (tombstone / successor) まわりの契約 ──────────────────

// 回帰 + 契約の明文化: 同一 ID の delete+create (replace 意味論) は plan として不正。
// applyMutationToGraph 単体は削除フィルタが ID で両方消すため、もし素通りすると
// 「作ったつもりのノードが黙って消える」— それを validateMutation が二重に弾いている
// (plan 内重複 ID + create 先の現存) ことをここで固定する。
test("同一 ID の delete+create は loud に reject される (replace 意味論は無い)", () => {
  const currentGraph = {
    nodes: [{ id: "doc:n1", type: "Decision", title: "old", summary: "old" }],
    edges: [],
  };
  const plan = {
    reason: "same-id replace",
    nodes: [
      { op: "delete", id: "doc:n1" },
      { op: "create", id: "doc:n1", type: "Decision", title: "new", summary: "new" },
    ],
    edges: [],
  };
  const v = validateMutation({ currentGraph, plan });
  assert.equal(v.valid, false);
  assert.ok(v.failures.some((f) => f.includes("duplicate node id: doc:n1")));
  assert.ok(v.failures.some((f) => f.includes("already exists in graph: doc:n1")));
});

test("successors: old はこの plan の delete、new は mutation 後に実在することを要求する", () => {
  const currentGraph = {
    nodes: [
      { id: "doc:n1", type: "Decision", title: "old", summary: "old" },
      { id: "doc:keep", type: "Decision", title: "keep", summary: "keep" },
    ],
    edges: [],
  };
  const okPlan = {
    reason: "purge with successor",
    nodes: [
      { op: "delete", id: "doc:n1" },
      { op: "create", id: "doc:h1", type: "Decision", title: "new", summary: "new" },
    ],
    edges: [],
    successors: [{ old: "doc:n1", new: "doc:h1" }],
  };
  assert.equal(validateMutation({ currentGraph, plan: okPlan }).valid, true);

  const badOld = { ...okPlan, successors: [{ old: "doc:keep", new: "doc:h1" }] };
  const vBadOld = validateMutation({ currentGraph, plan: badOld });
  assert.equal(vBadOld.valid, false);
  assert.ok(vBadOld.failures.some((f) => f.includes("not deleted by this plan: doc:keep")));

  const badNew = { ...okPlan, successors: [{ old: "doc:n1", new: "doc:missing" }] };
  const vBadNew = validateMutation({ currentGraph, plan: badNew });
  assert.equal(vBadNew.valid, false);
  assert.ok(vBadNew.failures.some((f) => f.includes("does not exist after mutation: doc:missing")));
});

test("normalizeMutationPlan: 形の崩れた successors は明示エラー", () => {
  assert.throws(
    () =>
      normalizeMutationPlan({
        nodes: [{ op: "delete", id: "doc:n1" }],
        successors: [{ old: "doc:n1" }],
      }),
    /successors must be an array/
  );
});

test("カスケード削除はエッジ id だけでなく全タプル (from/to/type) を audit に残す", () => {
  const graph = {
    nodes: [
      { id: "doc:n1", type: "Decision", title: "victim", summary: "v" },
      { id: "decision:s:mine", type: "Decision", title: "mine", summary: "m" },
    ],
    edges: [
      { id: "e1", type: "refines", from: "decision:s:mine", to: "doc:n1" },
    ],
  };
  const plan = normalizeMutationPlan({ nodes: [{ op: "delete", id: "doc:n1" }] });
  const audit = { cascadedEdgeIds: [] as string[], cascadedEdges: [] as any[] };
  applyMutationToGraph(graph, plan, audit);
  assert.deepEqual(audit.cascadedEdgeIds, ["e1"]);
  assert.deepEqual(audit.cascadedEdges, [
    { id: "e1", type: "refines", from: "decision:s:mine", to: "doc:n1" },
  ]);
});

// --- unknown attribute warnings (issue #20) --------------------------------

test("updates の未知属性名は WARN (typo に気付ける): did_you_mean と修復手順を同梱", () => {
  const plan = { reason: "typo", nodes: [
    { op: "update", id: "decision:s:a", updates: { summary_append: "..." } },
  ], edges: [] };
  const v = validateMutation({ currentGraph: baseGraph(), plan });
  assert.equal(v.valid, true, v.failures.join("; "));
  assert.equal(v.attributeWarnings.length, 1);
  const w = v.attributeWarnings[0];
  assert.equal(w.entity, "node");
  assert.equal(w.id, "decision:s:a");
  assert.equal(w.key, "summary_append");
  assert.equal(w.did_you_mean, "summary");
  assert.ok(w.message.includes('"summary_append":null'), "repair plan should delete the stray key");
  assert.ok(w.message.includes("ignore this warning"), "intentional use must stay legal");
});

test("既知モデル属性の updates は警告なし", () => {
  const plan = { reason: "ok", nodes: [
    { op: "update", id: "decision:s:a", updates: { summary: "new", state: null } },
  ], edges: [] };
  const v = validateMutation({ currentGraph: baseGraph(), plan });
  assert.deepEqual(v.attributeWarnings, []);
});

test("既存のモデル外キーを更新するのは意図的運用として警告なし", () => {
  const graph = baseGraph();
  (graph.nodes[0] as any).enforced_by = ["a.test.ts::x"];
  const plan = { reason: "custom", nodes: [
    { op: "update", id: "decision:s:a", updates: { enforced_by: ["a.test.ts::y"] } },
  ], edges: [] };
  const v = validateMutation({ currentGraph: graph, plan });
  assert.deepEqual(v.attributeWarnings, []);
});

test("未知キーへの null (迷い込んだキーの掃除) は警告しない", () => {
  const plan = { reason: "cleanup", nodes: [
    { op: "update", id: "decision:s:a", updates: { summary_append: null } },
  ], edges: [] };
  const v = validateMutation({ currentGraph: baseGraph(), plan });
  assert.deepEqual(v.attributeWarnings, []);
});

test("create の未知属性名も WARN (sumary typo)", () => {
  const plan = { reason: "typo-create", nodes: [
    { op: "create", id: "decision:s:c", type: "Decision", title: "C", sumary: "oops" },
  ], edges: [] };
  const v = validateMutation({ currentGraph: baseGraph(), plan });
  assert.equal(v.attributeWarnings.length, 1);
  assert.equal(v.attributeWarnings[0].key, "sumary");
  assert.equal(v.attributeWarnings[0].did_you_mean, "summary");
});

test("edge の未知属性名も WARN、id/type/from/to は警告なし", () => {
  const okPlan = { reason: "edge-ok", nodes: [], edges: [
    { op: "update", id: "e1", type: "refines", from: "decision:s:a", to: "decision:s:b" },
  ]};
  assert.deepEqual(validateMutation({ currentGraph: baseGraph(), plan: okPlan }).attributeWarnings, []);
  const typoPlan = { reason: "edge-typo", nodes: [], edges: [
    { op: "update", id: "e1", updates: { formm: "decision:s:b" } },
  ]};
  const v = validateMutation({ currentGraph: baseGraph(), plan: typoPlan });
  assert.equal(v.attributeWarnings.length, 1);
  assert.equal(v.attributeWarnings[0].entity, "edge");
  assert.equal(v.attributeWarnings[0].key, "formm");
  assert.equal(v.attributeWarnings[0].did_you_mean, "from");
});

test("delete op は属性警告の対象外", () => {
  const plan = { reason: "del", nodes: [{ op: "delete", id: "decision:s:b", stray_key: 1 }], edges: [] };
  const v = validateMutation({ currentGraph: baseGraph(), plan });
  assert.deepEqual(v.attributeWarnings, []);
});

// ── partitionIdempotentReplays (issue #24) ──────────────────────────────────
import { partitionIdempotentReplays } from "./mutation-core.ts";

test("idempotent replay: 同一内容の op:create 再送は plan から落ち replayed に載る", () => {
  const plan = {
    reason: "retry",
    nodes: [{ op: "create", id: "decision:s:a", type: "Decision", title: "A", summary: "a" }],
    edges: [{ op: "create", id: "e1", type: "refines", from: "decision:s:a", to: "decision:s:b" }],
  };
  const p = partitionIdempotentReplays(plan, baseGraph());
  assert.deepEqual(p.replayedNodeIds, ["decision:s:a"]);
  assert.deepEqual(p.replayedEdgeIds, ["e1"]);
  assert.equal(p.plan.nodes.length, 0);
  assert.equal(p.plan.edges.length, 0);
});

test("idempotent replay: 内容が違う create は落とさない (validate が fail-loud する)", () => {
  const plan = {
    reason: "conflict",
    nodes: [{ op: "create", id: "decision:s:a", type: "Decision", title: "CHANGED", summary: "a" }],
    edges: [],
  };
  const p = partitionIdempotentReplays(plan, baseGraph());
  assert.deepEqual(p.replayedNodeIds, []);
  assert.equal(p.plan.nodes.length, 1);
  const v = validateMutation({ currentGraph: baseGraph(), plan: p.plan });
  assert.equal(v.valid, false);
  assert.ok(v.failures.some((f) => f.includes("content DIFFERS")), v.failures.join("; "));
});

test("idempotent replay: generated_at の差だけなら再送とみなす / update・delete は対象外", () => {
  const plan = {
    reason: "retry",
    nodes: [
      { op: "create", id: "decision:s:a", type: "Decision", title: "A", summary: "a", generated_at: "2099-01-01T00:00:00Z" },
      { op: "update", id: "decision:s:b", updates: { summary: "b" } },
    ],
    edges: [],
  };
  const p = partitionIdempotentReplays(plan, baseGraph());
  assert.deepEqual(p.replayedNodeIds, ["decision:s:a"]);
  assert.equal(p.plan.nodes.length, 1, "update は残る");
  assert.equal(p.plan.nodes[0].op, "update");
});

test("idempotent replay: 同一 id で from/to が違う edge create は再送ではない", () => {
  const plan = {
    reason: "conflict",
    nodes: [],
    edges: [{ op: "create", id: "e1", type: "refines", from: "decision:s:b", to: "decision:s:a" }],
  };
  const p = partitionIdempotentReplays(plan, baseGraph());
  assert.deepEqual(p.replayedEdgeIds, []);
  assert.equal(p.plan.edges.length, 1);
});

test("idempotent replay: 同一 id の replay + 内容違い create が併存したら replay だけ落とし衝突は fail-loud (指摘 #3)", () => {
  const plan = {
    reason: "retry+conflict",
    nodes: [
      { op: "create", id: "decision:s:a", type: "Decision", title: "A", summary: "a" },
      { op: "create", id: "decision:s:a", type: "Decision", title: "A", summary: "CHANGED" },
    ],
    edges: [],
  };
  const p = partitionIdempotentReplays(plan, baseGraph());
  assert.deepEqual(p.replayedNodeIds, ["decision:s:a"], "replay 判定は identical 側の 1 item のみ");
  assert.equal(p.plan.nodes.length, 1, "内容違い側は plan に残る");
  assert.equal(p.plan.nodes[0].summary, "CHANGED");
  const v = validateMutation({ currentGraph: baseGraph(), plan: p.plan });
  assert.equal(v.valid, false, "残った衝突 create は fail-loud");
  assert.ok(v.failures.some((f) => f.includes("content DIFFERS")));
});

test("idempotent replay: 既存より少ないフィールドの create は replay ではない (subset 比較の衝突隠蔽防止, 指摘 #9)", () => {
  const plan = {
    reason: "minimal collision",
    nodes: [{ op: "create", id: "decision:s:a", type: "Decision", title: "A" }], // summary 欠落
    edges: [],
  };
  const p = partitionIdempotentReplays(plan, baseGraph());
  assert.deepEqual(p.replayedNodeIds, [], "対称比較: 既存の summary と plan の undefined が不一致");
  const v = validateMutation({ currentGraph: baseGraph(), plan: p.plan });
  assert.equal(v.valid, false, "id 衝突として fail-loud する");
});

// ── source backing (issue #28): 差分比較 + provenance edge 限定 ──────────────
//
// backed = 「provenance edge (documented_by/derived_from) で qualifying source に接続」。
// mutation の before/after 両方の全 distilled node について backing を比較し、
// (a) 新規 distilled node が after で unbacked、(b) before で backed だった node が
// after で unbacked、の両遷移を拒否する。before から unbacked の legacy は猶予。

// backed な Decision (File + documented_by) を持つ基準グラフ。
const backedGraph = () => ({
  nodes: [
    { id: "file:s:src/a.ts", type: "File", title: "a.ts", path: "src/a.ts" },
    { id: "decision:s:a", type: "Decision", title: "A", summary: "a" },
  ],
  edges: [
    {
      id: "decision_s_a__documented_by__file_s_src_a.ts",
      type: "documented_by",
      from: "decision:s:a",
      to: "file:s:src/a.ts",
    },
  ],
});

test("source backing: documented_by edge だけの削除は拒否 (plan.nodes 空でも backed→unbacked を捕捉)", () => {
  const plan = {
    reason: "strip edge",
    nodes: [],
    edges: [{ op: "delete", id: "decision_s_a__documented_by__file_s_src_a.ts" }],
  };
  const v = validateMutation({ currentGraph: backedGraph(), plan, enforceSourceBacking: true });
  assert.equal(v.valid, false, "edge-only delete must not silently orphan decision:s:a");
  assert.ok(
    v.failures.some((f) => f.includes("decision:s:a") && f.includes("backed")),
    v.failures.join("; ")
  );
});

test("source backing: File 削除の DETACH cascade で unbacked になる Decision を拒否", () => {
  const plan = {
    reason: "delete source",
    nodes: [{ op: "delete", id: "file:s:src/a.ts" }],
    edges: [],
  };
  const v = validateMutation({ currentGraph: backedGraph(), plan, enforceSourceBacking: true });
  assert.equal(v.valid, false, "cascade must not silently orphan decision:s:a");
  assert.ok(v.failures.some((f) => f.includes("decision:s:a")), v.failures.join("; "));
});

test("source backing: 非 provenance edge (sets_policy_for → File) は backing に数えない", () => {
  const plan = {
    reason: "bypass via sets_policy_for",
    nodes: [
      { op: "create", id: "decision:s:p", type: "Decision", title: "P", summary: "p" },
      { op: "create", id: "file:s:src/p.ts", type: "File", title: "p.ts", path: "src/p.ts" },
    ],
    edges: [
      { op: "create", id: "ep1", type: "sets_policy_for", from: "decision:s:p", to: "file:s:src/p.ts" },
    ],
  };
  const v = validateMutation({ currentGraph: { nodes: [], edges: [] }, plan, enforceSourceBacking: true });
  assert.equal(v.valid, false, "sets_policy_for must not count as source backing");
  assert.ok(v.failures.some((f) => f.includes("decision:s:p")), v.failures.join("; "));
});

test("source backing: risks_in / rejected_in / temporary_relation_candidate も backing に数えない", () => {
  // ターゲットはすべて qualifying source (path 付き File / raw_content 付き Investigation /
  // raw_content 付き ConversationChunk) — edge type が provenance でない限り backed にならないこと。
  const plan = {
    reason: "bypass via non-provenance edges",
    nodes: [
      { op: "create", id: "risk:s:r", type: "Risk", title: "R", summary: "r" },
      { op: "create", id: "rejectedoption:s:x", type: "RejectedOption", title: "X", summary: "x" },
      { op: "create", id: "decision:s:t", type: "Decision", title: "T", summary: "t" },
      { op: "create", id: "file:s:src/r.ts", type: "File", title: "r.ts", path: "src/r.ts" },
      { op: "create", id: "investigation:s:i", type: "Investigation", title: "I", raw_content: "log", state: "closed" },
      { op: "create", id: "conversationchunk:s:c", type: "ConversationChunk", title: "C", raw_content: "talk" },
    ],
    edges: [
      { op: "create", id: "er1", type: "risks_in", from: "risk:s:r", to: "file:s:src/r.ts" },
      { op: "create", id: "er2", type: "rejected_in", from: "rejectedoption:s:x", to: "investigation:s:i" },
      { op: "create", id: "er3", type: "temporary_relation_candidate", from: "decision:s:t", to: "conversationchunk:s:c" },
    ],
  };
  const v = validateMutation({ currentGraph: { nodes: [], edges: [] }, plan, enforceSourceBacking: true });
  assert.equal(v.valid, false);
  for (const id of ["risk:s:r", "rejectedoption:s:x", "decision:s:t"]) {
    assert.ok(v.failures.some((f) => f.includes(id)), `${id} must be reported: ${v.failures.join("; ")}`);
  }
});

test("source backing: File の path を空にする update で依存 Decision が unbacked → 拒否", () => {
  const plan = {
    reason: "degrade source",
    nodes: [{ op: "update", id: "file:s:src/a.ts", updates: { path: "" } }],
    edges: [],
  };
  const v = validateMutation({ currentGraph: backedGraph(), plan, enforceSourceBacking: true });
  assert.equal(v.valid, false, "path-less File is no longer a qualifying source");
  assert.ok(v.failures.some((f) => f.includes("decision:s:a")), v.failures.join("; "));
});

test("source backing: source の raw_content_status を copied_from_summary にする update で依存 node が unbacked → 拒否", () => {
  const graph = {
    nodes: [
      { id: "conversationchunk:s:c", type: "ConversationChunk", title: "C", raw_content: "talk" },
      { id: "decision:s:d", type: "Decision", title: "D", summary: "d" },
    ],
    edges: [
      { id: "ed1", type: "derived_from", from: "decision:s:d", to: "conversationchunk:s:c" },
    ],
  };
  const plan = {
    reason: "degrade chunk",
    nodes: [
      { op: "update", id: "conversationchunk:s:c", updates: { raw_content_status: "copied_from_summary" } },
    ],
    edges: [],
  };
  const v = validateMutation({ currentGraph: graph, plan, enforceSourceBacking: true });
  assert.equal(v.valid, false);
  assert.ok(v.failures.some((f) => f.includes("decision:s:d")), v.failures.join("; "));
});

test("source backing: legacy 猶予 — before から unbacked の既存 node は無関係な mutation をブロックしない", () => {
  const graph = {
    nodes: [{ id: "decision:s:legacy", type: "Decision", title: "L", summary: "l" }],
    edges: [],
  };
  const plan = {
    reason: "unrelated",
    nodes: [{ op: "create", id: "file:s:src/n.ts", type: "File", title: "n.ts", path: "src/n.ts" }],
    edges: [],
  };
  const v = validateMutation({ currentGraph: graph, plan, enforceSourceBacking: true });
  assert.equal(v.valid, true, v.failures.join("; "));
});

test("source backing: legacy 猶予 — before から unbacked の node 自体の update も通る (既存 vault を壊さない)", () => {
  const graph = {
    nodes: [{ id: "decision:s:legacy", type: "Decision", title: "L", summary: "l" }],
    edges: [],
  };
  const plan = {
    reason: "benign update",
    nodes: [{ op: "update", id: "decision:s:legacy", updates: { summary: "l2" } }],
    edges: [],
  };
  const v = validateMutation({ currentGraph: graph, plan, enforceSourceBacking: true });
  assert.equal(v.valid, true, v.failures.join("; "));
});

test("source backing: copied_from_summary スタンプ付き legacy node の新設は従来どおり通る (honest marker)", () => {
  const plan = {
    reason: "stamped legacy migration",
    nodes: [
      {
        op: "create", id: "decision:s:stamped", type: "Decision", title: "S", summary: "s",
        raw_content: "s", raw_content_status: "copied_from_summary",
      },
    ],
    edges: [],
  };
  const v = validateMutation({ currentGraph: { nodes: [], edges: [] }, plan, enforceSourceBacking: true });
  assert.equal(v.valid, true, v.failures.join("; "));
});

test("source backing: cross-vault documented_by のみでも backed 扱い (validateGraph の existence skip と同じ整合)", () => {
  const plan = {
    reason: "cross-vault backed",
    nodes: [{ op: "create", id: "decision:s:xv", type: "Decision", title: "XV", summary: "xv" }],
    edges: [
      { op: "create", id: "exv1", type: "documented_by", from: "decision:s:xv", to: "vault:other/file:o:src/x.ts" },
    ],
  };
  const v = validateMutation({ currentGraph: { nodes: [], edges: [] }, plan, enforceSourceBacking: true });
  assert.equal(v.valid, true, v.failures.join("; "));
});

test("source backing: 正常系 — documented_by 付き追加は通り、node ごと削除 (cascade 込み) も通る", () => {
  const addPlan = {
    reason: "add backed decision",
    nodes: [
      { op: "create", id: "decision:s:n", type: "Decision", title: "N", summary: "n" },
      { op: "create", id: "file:s:src/n.ts", type: "File", title: "n.ts", path: "src/n.ts" },
    ],
    edges: [
      { op: "create", id: "en1", type: "documented_by", from: "decision:s:n", to: "file:s:src/n.ts" },
    ],
  };
  const add = validateMutation({ currentGraph: { nodes: [], edges: [] }, plan: addPlan, enforceSourceBacking: true });
  assert.equal(add.valid, true, add.failures.join("; "));

  const deletePlan = {
    reason: "delete decision together with its edge",
    nodes: [{ op: "delete", id: "decision:s:a" }],
    edges: [],
  };
  const del = validateMutation({ currentGraph: backedGraph(), plan: deletePlan, enforceSourceBacking: true });
  assert.equal(del.valid, true, del.failures.join("; "));
});
