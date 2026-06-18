import assert from "node:assert/strict";
import test from "node:test";
import {
  runDuplicateCheck,
  DUPLICATE_SUSPECT_THRESHOLD,
  DUPLICATE_CHECK_NODE_TYPES,
  RELATION_BAND_LOW,
  RELATION_BAND_HIGH,
} from "./duplicate-check.ts";

// 既存ノードと索引を揃って用意する。索引行 vector は単位ベクトルで cosine を直に制御。
const graphWith = (...nodes: any[]) => ({ nodes });
const indexWith = (...rows: any[]) => ({ rows });
const embedConst = (vector: number[]) => async () => vector;

const existingDecision = { id: "decision:s:a", type: "Decision", title: "A", summary: "a" };

test("閾値は check-carving #10 と同値 (0.92)", () => {
  assert.equal(DUPLICATE_SUSPECT_THRESHOLD, 0.92);
});

test("op:create の同型ノードが閾値以上なら rejected (failures 形式も契約どおり)", async () => {
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:a2", type: "Decision", title: "A", summary: "a" }],
    },
    currentGraph: graphWith(existingDecision),
    vectorIndex: indexWith({ node_id: "decision:s:a", vector: [1, 0, 0] }),
    embed: embedConst([1, 0, 0]),
  });
  assert.equal(res.status, "rejected");
  assert.deepEqual(res.suspects, [
    { new_id: "decision:s:a2", existing_id: "decision:s:a", similarity: 1 },
  ]);
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
  const existing2 = { id: "decision:s:b", type: "Decision", title: "A", summary: "a" };
  const res = await runDuplicateCheck({
    plan: {
      nodes: [{ op: "create", id: "decision:s:a2", type: "Decision", title: "A", summary: "a" }],
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
      nodes: [{ op: "create", id: "decision:s:a2", type: "Decision", title: "A", summary: "a" }],
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
      nodes: [{ op: "create", id: "decision:s:a2", type: "Decision", title: "A", summary: "a" }],
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

test("対象型は契約の知識/横断ノード閉集合", () => {
  assert.deepEqual(
    [...DUPLICATE_CHECK_NODE_TYPES].sort(),
    [
      "Component",
      "Concern",
      "Constraint",
      "Decision",
      "Goal",
      "Investigation",
      "Layer",
      "OperationalKnowledge",
      "RejectedOption",
      "Risk",
    ]
  );
});
