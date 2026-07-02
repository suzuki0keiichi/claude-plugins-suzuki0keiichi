import assert from "node:assert/strict";
import test from "node:test";
import {
  runDuplicateCheck,
  DUPLICATE_SUSPECT_THRESHOLD,
  DUPLICATE_CHECK_NODE_TYPES,
  RELATION_BAND_LOW,
  RELATION_BAND_HIGH,
  duplicateGateText,
} from "./duplicate-check.ts";
import { DEFAULT_SCHEMA } from "./schema.ts";
import { nodeVectorText } from "./vector.ts";

// 既存ノードと索引を揃って用意する。索引行 vector は単位ベクトルで cosine を直に制御。
const graphWith = (...nodes: any[]) => ({ nodes });
const indexWith = (...rows: any[]) => ({ rows });
const embedConst = (vector: number[]) => async () => vector;

const existingDecision = { id: "decision:s:a", type: "Decision", title: "A", summary: "a" };

test("閾値は check-carving #10 と同値 (0.92)", () => {
  assert.equal(DUPLICATE_SUSPECT_THRESHOLD, 0.92);
});

test("op:create の同型ノードが閾値以上なら rejected (failures 形式も契約どおり)", async () => {
  // title を変えて lexical pre-pass を通らない形にし、embedding 段の挙動を単独で観測する。
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:a2", type: "Decision", title: "A2", summary: "a" }],
    },
    currentGraph: graphWith(existingDecision),
    vectorIndex: indexWith({ node_id: "decision:s:a", vector: [1, 0, 0] }),
    embed: embedConst([1, 0, 0]),
  });
  assert.equal(res.status, "rejected");
  assert.equal(res.suspects.length, 1);
  const s = res.suspects[0];
  assert.equal(s.new_id, "decision:s:a2");
  assert.equal(s.existing_id, "decision:s:a");
  assert.equal(s.similarity, 1);
  assert.equal(s.basis, "embedding");
  // suspect は「壁」でなく判断材料: 既存ノードの要点 + next_step が同梱される。
  assert.deepEqual(s.existing, { type: "Decision", title: "A", summary: "a" });
  assert.match(s.next_step, /update decision:s:a via commit-mutation/);
  assert.match(s.next_step, /supersede/);
  assert.match(s.next_step, /--dup-ack decision:s:a/);
  assert.deepEqual(res.failures, [
    "duplicate-suspect: decision:s:a2 ~ decision:s:a (similarity 1.00)",
  ]);
});

test("閾値未満なら ok (suspect 無し)", async () => {
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:b", type: "Decision", title: "B", summary: "b" }],
    },
    currentGraph: graphWith(existingDecision),
    vectorIndex: indexWith({ node_id: "decision:s:a", vector: [1, 0, 0] }),
    embed: embedConst([0, 1, 0]), // cosine 0
  });
  assert.equal(res.status, "ok");
  assert.deepEqual(res.suspects, []);
  assert.deepEqual(res.failures, []);
});

test("duplicate_ack が全 suspect を覆えば acked (suspects は可視のまま)", async () => {
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:a2", type: "Decision", title: "A", summary: "a" }],
      duplicate_ack: ["decision:s:a"],
    },
    currentGraph: graphWith(existingDecision),
    vectorIndex: indexWith({ node_id: "decision:s:a", vector: [1, 0, 0] }),
    embed: embedConst([1, 0, 0]),
  });
  assert.equal(res.status, "acked");
  assert.equal(res.suspects.length, 1);
  assert.deepEqual(res.failures, []);
});

test("ack が一部しか覆わなければ rejected (failures は未承認分のみ)", async () => {
  const existing2 = { id: "decision:s:b", type: "Decision", title: "B2", summary: "a" };
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:a2", type: "Decision", title: "A2", summary: "a" }],
      duplicate_ack: ["decision:s:a"],
    },
    currentGraph: graphWith(existingDecision, existing2),
    vectorIndex: indexWith(
      { node_id: "decision:s:a", vector: [1, 0, 0] },
      { node_id: "decision:s:b", vector: [1, 0, 0] }
    ),
    embed: embedConst([1, 0, 0]),
  });
  assert.equal(res.status, "rejected");
  assert.equal(res.suspects.length, 2, "suspects は ack 済み含め全件");
  assert.deepEqual(res.failures, [
    "duplicate-suspect: decision:s:a2 ~ decision:s:b (similarity 1.00)",
  ]);
});

test("同型のみ比較: 別型の既存ノードがいくら近くても suspect にしない", async () => {
  const risk = { id: "risk:s:a", type: "Risk", title: "A", summary: "a" };
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:a2", type: "Decision", title: "A", summary: "a" }],
    },
    currentGraph: graphWith(risk),
    vectorIndex: indexWith({ node_id: "risk:s:a", vector: [1, 0, 0] }),
    embed: embedConst([1, 0, 0]),
  });
  assert.equal(res.status, "ok");
});

test("alias 型 (Vein=Concern) は canonical で同型として照合される", async () => {
  const concern = { id: "concern:s:auth", type: "Concern", title: "auth", summary: "authentication" };
  const res = await runDuplicateCheck({
    plan: {
      nodes: [
        { op: "create", id: "vein:s:auth2", type: "Vein", title: "auth", summary: "authentication" },
      ],
    },
    currentGraph: graphWith(concern),
    vectorIndex: indexWith({ node_id: "concern:s:auth", vector: [1, 0, 0] }),
    embed: embedConst([1, 0, 0]),
  });
  assert.equal(res.status, "rejected");
  assert.equal(res.suspects[0].existing_id, "concern:s:auth");
});

test("対象外型 (File/ConversationChunk) の create はゲートを素通り (embed も呼ばない)", async () => {
  let embedCalls = 0;
  const res = await runDuplicateCheck({
    plan: {
      nodes: [
        { op: "create", id: "file:s:x.ts", type: "File", title: "x.ts", path: "src/x.ts" },
        { op: "create", id: "chunk:s:c1", type: "ConversationChunk", title: "c1", summary: "log" },
      ],
    },
    currentGraph: graphWith(existingDecision),
    vectorIndex: indexWith({ node_id: "decision:s:a", vector: [1, 0, 0] }),
    embed: async () => {
      embedCalls += 1;
      return [1, 0, 0];
    },
  });
  assert.equal(res.status, "ok");
  assert.equal(embedCalls, 0);
});

test("op:update / op:delete は対象外 (create のみ照合)", async () => {
  const res = await runDuplicateCheck({
    plan: {
      nodes: [
        { op: "update", id: "decision:s:a", updates: { summary: "a2" } },
        { op: "delete", id: "decision:s:b" },
      ],
    },
    currentGraph: graphWith(existingDecision),
    vectorIndex: indexWith({ node_id: "decision:s:a", vector: [1, 0, 0] }),
    embed: embedConst([1, 0, 0]),
  });
  assert.equal(res.status, "ok");
});

test("vector index 不在は非致命 skipped (reason 付き)", async () => {
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:c", type: "Decision", title: "C", summary: "c" }],
    },
    currentGraph: graphWith(existingDecision),
    vectorIndex: null,
    embed: embedConst([1, 0, 0]),
  });
  assert.equal(res.status, "skipped");
  assert.ok(res.reason, "reason で skip 理由を可視化");
  assert.deepEqual(res.failures, []);
});

test("embedding 不達 (embed throw) は非致命 skipped", async () => {
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:c", type: "Decision", title: "C", summary: "c" }],
    },
    currentGraph: graphWith(existingDecision),
    vectorIndex: indexWith({ node_id: "decision:s:a", vector: [1, 0, 0] }),
    embed: async () => {
      throw new Error("endpoint down");
    },
  });
  assert.equal(res.status, "skipped");
  assert.match(res.reason ?? "", /endpoint down/);
});

test("索引行が非正規化ベクトルでも真の cosine で判定する", async () => {
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:a2", type: "Decision", title: "A", summary: "a" }],
    },
    currentGraph: graphWith(existingDecision),
    vectorIndex: indexWith({ node_id: "decision:s:a", vector: [5, 0, 0] }),
    embed: embedConst([2, 0, 0]), // 方向一致 = cosine 1.0 (素の内積なら 10 で誤判定)
  });
  assert.equal(res.status, "rejected");
  assert.equal(res.suspects[0].similarity, 1);
});

test("索引にだけ残る stale 行 (graph に居ない id) は比較対象にしない", async () => {
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:a2", type: "Decision", title: "A", summary: "a" }],
    },
    currentGraph: graphWith(), // 索引行に対応するノードが居ない
    vectorIndex: indexWith({ node_id: "decision:s:ghost", vector: [1, 0, 0] }),
    embed: embedConst([1, 0, 0]),
  });
  assert.equal(res.status, "ok");
});

// ── E0 relations 帯 (suggest-only 副産物) ────────────────────────────────
test("帯定数は [0.80, 0.92) (重複帯の直下まで)", () => {
  assert.equal(RELATION_BAND_LOW, 0.8);
  assert.equal(RELATION_BAND_HIGH, DUPLICATE_SUSPECT_THRESHOLD);
  assert.equal(RELATION_BAND_HIGH, 0.92);
});

// 単位ベクトル [cosθ, sinθ] で row との cosine を狙い値に。candidate=[1,0] なら row[0]=cosine。
const unit = (c: number) => [c, Math.sqrt(Math.max(0, 1 - c * c))];

test("[0.80,0.92) 帯の同型ペアは relations に拾われる (suspect ではない・status ok)", async () => {
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:a2", type: "Decision", title: "A2", summary: "a" }],
    },
    currentGraph: graphWith(existingDecision),
    vectorIndex: indexWith({ node_id: "decision:s:a", vector: unit(0.85) }),
    embed: embedConst([1, 0]),
  });
  assert.equal(res.status, "ok", "帯内は重複ではないので reject しない");
  assert.deepEqual(res.suspects, []);
  assert.equal(res.relations.length, 1);
  assert.equal(res.relations[0].new_id, "decision:s:a2");
  assert.equal(res.relations[0].existing_id, "decision:s:a");
  assert.ok(res.relations[0].similarity >= 0.8 && res.relations[0].similarity < 0.92);
  // relations 候補にも既存ノードの要点が同梱される (判断材料)。
  assert.deepEqual(res.relations[0].existing, { type: "Decision", title: "A", summary: "a" });
});

test("0.92 以上は suspect 帯なので relations には入らない (二重計上しない)", async () => {
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:a2", type: "Decision", title: "A", summary: "a" }],
    },
    currentGraph: graphWith(existingDecision),
    vectorIndex: indexWith({ node_id: "decision:s:a", vector: [1, 0, 0] }),
    embed: embedConst([1, 0, 0]), // cosine 1.0
  });
  assert.equal(res.status, "rejected");
  assert.deepEqual(res.relations, [], "suspect は relations に重複計上しない");
});

test("0.80 未満は relations にも入らない (帯下限の境界)", async () => {
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:a2", type: "Decision", title: "A2", summary: "a" }],
    },
    currentGraph: graphWith(existingDecision),
    vectorIndex: indexWith({ node_id: "decision:s:a", vector: unit(0.7) }),
    embed: embedConst([1, 0]),
  });
  assert.equal(res.status, "ok");
  assert.deepEqual(res.relations, []);
});

test("index/embed 不在の skip でも relations フィールドは存在 (空)", async () => {
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:c", type: "Decision", title: "C", summary: "c" }],
    },
    currentGraph: graphWith(existingDecision),
    vectorIndex: null,
    embed: embedConst([1, 0, 0]),
  });
  assert.equal(res.status, "skipped");
  assert.deepEqual(res.relations, []);
});

test("対象型は契約の知識/横断ノード閉集合 (単一正本: schema categories.duplicateCheck)", () => {
  assert.deepEqual(
    [...DUPLICATE_CHECK_NODE_TYPES].sort(),
    [
      "Component",
      "Concern",
      "Constraint",
      "Decision",
      "Deliverable",
      "Goal",
      "Investigation",
      "Layer",
      "OperationalKnowledge",
      "RejectedOption",
      "Risk",
    ]
  );
  assert.deepEqual(
    [...DUPLICATE_CHECK_NODE_TYPES].sort(),
    [...DEFAULT_SCHEMA.categories.duplicateCheck].sort(),
    "check-carving の重複監査とゲートは schema categories.duplicateCheck を共有する"
  );
});

// ── lexical exact pre-pass (embedding 不達でも走る安価な完全一致検査) ─────────
test("lexical: 正規化 title 完全一致 (同型・同 system) は similarity 1 / basis lexical の suspect", async () => {
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:a2", type: "Decision", title: "  A ", summary: "different summary" }],
    },
    currentGraph: graphWith(existingDecision),
    vectorIndex: indexWith({ node_id: "decision:s:a", vector: unit(0.1) }),
    embed: embedConst([1, 0]), // embedding では遠い — lexical だけで捕まえる
  });
  assert.equal(res.status, "rejected");
  assert.equal(res.suspects.length, 1);
  assert.equal(res.suspects[0].basis, "lexical");
  assert.equal(res.suspects[0].similarity, 1);
  assert.equal(res.suspects[0].existing_id, "decision:s:a");
  assert.match(res.failures[0], /lexical exact match/);
});

test("lexical: embedding 不達 (embed throw) でも走り、suspect があれば reject する", async () => {
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:a2", type: "Decision", title: "A", summary: "x" }],
    },
    currentGraph: graphWith(existingDecision),
    vectorIndex: indexWith({ node_id: "decision:s:a", vector: [1, 0, 0] }),
    embed: async () => {
      throw new Error("endpoint down");
    },
  });
  assert.equal(res.status, "rejected", "embedding skip でも lexical suspect は壁として機能する");
  assert.equal(res.suspects[0].basis, "lexical");
  assert.match(res.reason ?? "", /endpoint down/, "embedding 段の skip 理由も正直に残る");
});

test("lexical: vector index 不在でも走る (title↔alias 一致)", async () => {
  const existing = { id: "decision:s:a", type: "Decision", title: "別名の題", summary: "a", aliases: ["auto update"] };
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:auto", type: "Decision", title: "Auto  Update", summary: "x" }],
    },
    currentGraph: graphWith(existing),
    vectorIndex: null,
    embed: embedConst([1, 0, 0]),
  });
  assert.equal(res.status, "rejected");
  assert.equal(res.suspects[0].basis, "lexical");
  assert.equal(res.suspects[0].existing_id, "decision:s:a");
});

test("lexical: 型違い・system 違いでは発火しない", async () => {
  const otherType = { id: "risk:s:a", type: "Risk", title: "A", summary: "a" };
  const otherSystem = { id: "decision:t:a", type: "Decision", title: "A", summary: "a" };
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:a2", type: "Decision", title: "A", summary: "x" }],
    },
    currentGraph: graphWith(otherType, otherSystem),
    vectorIndex: null,
    embed: embedConst([1, 0, 0]),
  });
  assert.equal(res.status, "skipped", "lexical 衝突なし + index 不在 = 従来どおり skipped");
  assert.deepEqual(res.suspects, []);
});

test("lexical: --dup-ack (duplicate_ack) で承認できる", async () => {
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:a2", type: "Decision", title: "A", summary: "x" }],
      duplicate_ack: ["decision:s:a"],
    },
    currentGraph: graphWith(existingDecision),
    vectorIndex: null,
    embed: embedConst([1, 0, 0]),
  });
  assert.equal(res.status, "acked");
  assert.deepEqual(res.failures, []);
});

test("lexical と embedding が同ペアを見つけても二重計上しない", async () => {
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:a2", type: "Decision", title: "A", summary: "a" }],
    },
    currentGraph: graphWith(existingDecision),
    vectorIndex: indexWith({ node_id: "decision:s:a", vector: [1, 0, 0] }),
    embed: embedConst([1, 0, 0]), // embedding でも cosine 1.0
  });
  assert.equal(res.status, "rejected");
  assert.equal(res.suspects.length, 1, "同ペアは 1 件 (lexical 優先)");
  assert.equal(res.suspects[0].basis, "lexical");
});

// ── lexical pre-pass × 終端 state (#9 回帰) ──────────────────────────────────
// supersede レシピは後継が同タイトルを引き継ぐのが正規の運用。既存ノードが終端 state
// (もはや現役の担い手ではない) なら title/alias 衝突があっても suspect にしない。
test("lexical: state:superseded の既存ノードとの同名衝突は suspect にならない (書き込みは offline でも進める)", async () => {
  const superseded = { id: "decision:s:a", type: "Decision", title: "A", summary: "a", state: "superseded" };
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:a2", type: "Decision", title: "A", summary: "x" }],
    },
    currentGraph: graphWith(superseded),
    vectorIndex: null,
    embed: embedConst([1, 0, 0]),
  });
  assert.equal(res.status, "skipped", "終端 state 衝突は lexical suspect を出さず、index 不在で従来どおり skipped");
  assert.deepEqual(res.suspects, []);
});

test("lexical: alias 衝突でも既存ノードが終端 state なら suspect にならない", async () => {
  const superseded = {
    id: "decision:s:a",
    type: "Decision",
    title: "別名の題",
    summary: "a",
    aliases: ["auto update"],
    state: "superseded",
  };
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:auto", type: "Decision", title: "Auto  Update", summary: "x" }],
    },
    currentGraph: graphWith(superseded),
    vectorIndex: null,
    embed: embedConst([1, 0, 0]),
  });
  assert.equal(res.status, "skipped");
  assert.deepEqual(res.suspects, []);
});

test("lexical: 終端 state (closed / achieved / abandoned) も同様に衝突を素通りさせる", async () => {
  const terminalCases = [
    { id: "investigation:s:a", type: "Investigation", title: "調査A", summary: "a", state: "closed" },
    { id: "goal:s:a", type: "Goal", title: "目標A", summary: "a", state: "achieved" },
    { id: "goal:s:b", type: "Goal", title: "目標B", summary: "b", state: "abandoned" },
  ];
  for (const existing of terminalCases) {
    const res = await runDuplicateCheck({
      plan: {
        nodes: [{ op: "create", id: `${existing.type.toLowerCase()}:s:new`, type: existing.type, title: existing.title, summary: "x" }],
      },
      currentGraph: graphWith(existing),
      vectorIndex: null,
      embed: embedConst([1, 0, 0]),
    });
    assert.equal(res.status, "skipped", `state:${existing.state} は終端なので suspect にならない`);
    assert.deepEqual(res.suspects, []);
  }
});

test("lexical: 現役 (state 無し) の既存ノードとの同名衝突は引き続き suspect", async () => {
  // existingDecision は state 無し = 現役。終端 state スキップの対象外であること (回帰防止)。
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:a2", type: "Decision", title: "A", summary: "x" }],
    },
    currentGraph: graphWith(existingDecision),
    vectorIndex: null,
    embed: embedConst([1, 0, 0]),
  });
  assert.equal(res.status, "rejected");
  assert.equal(res.suspects[0].basis, "lexical");
  assert.equal(res.suspects[0].existing_id, "decision:s:a");
});

// ── cross-type suspects (suggest-only。reject に使わない) ────────────────────
test("cross-type: Decision↔OperationalKnowledge の閾値以上は cross_type_suspects (status ok)", async () => {
  const existingOk = { id: "ok:s:same", type: "OperationalKnowledge", title: "既存の運用知識", summary: "y" };
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:new", type: "Decision", title: "新しい決定", summary: "x" }],
    },
    currentGraph: graphWith(existingOk),
    vectorIndex: indexWith({ node_id: "ok:s:same", vector: [1, 0, 0] }),
    embed: embedConst([1, 0, 0]),
  });
  assert.equal(res.status, "ok", "型跨ぎは決して reject しない");
  assert.deepEqual(res.suspects, []);
  assert.deepEqual(res.failures, []);
  assert.equal(res.cross_type_suspects.length, 1);
  assert.equal(res.cross_type_suspects[0].existing_id, "ok:s:same");
  assert.equal(res.cross_type_suspects[0].existing?.type, "OperationalKnowledge");
});

test("cross-type: Risk↔Constraint も検査されるが、グループ外 (Decision↔Risk) は出ない", async () => {
  const existingConstraint = { id: "constraint:s:c", type: "Constraint", title: "制約", summary: "y" };
  const riskRes = await runDuplicateCheck({
    plan: { nodes: [{ op: "create", id: "risk:s:new", type: "Risk", title: "新リスク", summary: "x" }] },
    currentGraph: graphWith(existingConstraint),
    vectorIndex: indexWith({ node_id: "constraint:s:c", vector: [1, 0, 0] }),
    embed: embedConst([1, 0, 0]),
  });
  assert.equal(riskRes.cross_type_suspects.length, 1);
  assert.equal(riskRes.cross_type_suspects[0].existing_id, "constraint:s:c");

  const existingRisk = { id: "risk:s:r", type: "Risk", title: "リスク", summary: "y" };
  const decisionRes = await runDuplicateCheck({
    plan: { nodes: [{ op: "create", id: "decision:s:new", type: "Decision", title: "決定", summary: "x" }] },
    currentGraph: graphWith(existingRisk),
    vectorIndex: indexWith({ node_id: "risk:s:r", vector: [1, 0, 0] }),
    embed: embedConst([1, 0, 0]),
  });
  assert.deepEqual(decisionRes.cross_type_suspects, [], "Decision↔Risk はグループ外");
  assert.equal(decisionRes.status, "ok");
});

test("cross-type: 閾値未満は出ない", async () => {
  const existingOk = { id: "ok:s:far", type: "OperationalKnowledge", title: "遠い知識", summary: "y" };
  const res = await runDuplicateCheck({
    plan: { nodes: [{ op: "create", id: "decision:s:new", type: "Decision", title: "決定", summary: "x" }] },
    currentGraph: graphWith(existingOk),
    vectorIndex: indexWith({ node_id: "ok:s:far", vector: unit(0.85) }),
    embed: embedConst([1, 0]),
  });
  assert.deepEqual(res.cross_type_suspects, [], "cross-type は suspect 閾値 (0.92) のみ。band は拾わない");
});

// ── ゲートの埋め込みテキスト構成 (索引行との空間一致) ─────────────────────────
test("duplicateGateText は索引行の埋め込み入力 (nodeVectorText) と同一構成", () => {
  const node = {
    op: "create",
    id: "decision:s:x",
    type: "Decision",
    title: "T",
    summary: "S",
    description: "D",
    aliases: ["alias-1"],
    tags: ["tag-1"],
  };
  assert.equal(duplicateGateText(node), nodeVectorText(node));
  assert.match(duplicateGateText(node), /D/, "description も埋め込みテキストに含まれる");
  assert.match(duplicateGateText(node), /alias-1/, "aliases も含まれる (索引行と同じ)");
});
