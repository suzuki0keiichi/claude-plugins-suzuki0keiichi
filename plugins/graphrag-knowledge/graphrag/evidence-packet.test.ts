import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "./evidence-packet.ts";

test("evidence parseArgs reads --vault / GRAPHRAG_VAULT_DIR", () => {
  assert.equal(parseArgs(["--request", "r", "--vault", "/v"]).vault, "/v");
  const prev = process.env.GRAPHRAG_VAULT_DIR;
  process.env.GRAPHRAG_VAULT_DIR = "/env/v";
  try {
    assert.equal(parseArgs(["--request", "r"]).vault, "/env/v");
  } finally {
    if (prev === undefined) delete process.env.GRAPHRAG_VAULT_DIR;
    else process.env.GRAPHRAG_VAULT_DIR = prev;
  }
});

// referenced_ids は廃止 (graph_context.nodes が id キーの表になり重複したため)。
// カタログ用途は graph_context.nodes / direct_evidence の id で足りる。

// --- graph_context の slim 化 / 入力共有 (graphData/vectorIndex/queryVectors) ---

import { buildEvidencePacket, buildGraphContext } from "./evidence-packet.ts";

function evidenceFixture() {
  const long = "あ".repeat(300);
  return {
    nodes: [
      { id: "decision:s:hit", type: "Decision", title: "認証基盤", summary: long },
      { id: "risk:s:r1", type: "Risk", title: "リスク1", summary: long },
      { id: "risk:s:r2", type: "Risk", title: "リスク2", summary: "短い" }
    ],
    edges: [
      { id: "e1", type: "has_premise", from: "decision:s:hit", to: "risk:s:r1" },
      { id: "e2", type: "reduces_risk", from: "decision:s:hit", to: "risk:s:r2" }
    ]
  };
}

test("buildEvidencePacket: shared inputs (graphData/vectorIndex/queryVectors) skip disk+embedding", async () => {
  const packet = await buildEvidencePacket({
    request: "認証基盤",
    graphData: evidenceFixture(),
    vectorIndex: { provider: "fake", rows: [] },
    queryVectors: [[0]],
    limit: 8,
    neighbors: 1,
    types: []
  });
  // graph_context は nodes 表 (id キー・null 無し・~140 字要約) + 細い edges 配列
  const context = packet.graph_context;
  assert.ok(context.nodes && context.edges, "graph_context = { nodes, edges }");
  assert.equal(context.edges.length, 2);
  assert.deepEqual(context.edges[0], {
    depth: 1, relation: "has_premise", from: "decision:s:hit", to: "risk:s:r1"
  });
  // match ノード (direct_evidence で全文が出る) は nodes 表に再掲しない
  assert.ok(!("decision:s:hit" in context.nodes), "match ノードは表に載せない (重複排除)");
  // 近傍ノードは表に 1 回だけ、要約は 140 字上限、null/欠損フィールドは省略
  const neighbor = context.nodes["risk:s:r1"];
  assert.ok(neighbor, "近傍ノードは nodes 表に載る");
  assert.ok(neighbor.summary.length <= 140, `文脈ノード要約は ~140 字 (got ${neighbor.summary.length})`);
  assert.ok(!("path" in neighbor) && !("state" in neighbor) && !("aliases" in neighbor) && !("display" in neighbor));
  // direct_evidence は従来どおり全文 (nodeForOutput)
  assert.equal(packet.direct_evidence[0].node.summary.length, 300);
  // retrieval_policy の vector 記述は 1 系統のみ (旧: describeVectorIndex を 3 重に再掲)
  assert.ok(packet.retrieval_policy.vector);
  assert.ok(!("vector_provider" in packet.retrieval_policy));
  assert.ok(!("vector_provider_capability" in packet.retrieval_policy));
  // answer_instructions は 1 行 + ガイドへのポインタ
  assert.equal(typeof packet.answer_instructions, "string");
  assert.match(packet.answer_instructions, /ask-output-guide\.md/);
  // standout (相対 gap) を露出する
  assert.ok(packet.standout);
});

test("buildEvidencePacket honors the limit argument (was hardcoded 8 upstream)", async () => {
  const graph = { nodes: [], edges: [] };
  for (let i = 0; i < 12; i += 1) {
    graph.nodes.push({ id: `decision:s:n${i}`, type: "Decision", title: "認証" });
  }
  const packet = await buildEvidencePacket({
    request: "認証",
    graphData: graph,
    vectorIndex: { provider: "fake", rows: [] },
    queryVectors: [[0]],
    limit: 2,
    neighbors: 1,
    types: []
  });
  assert.equal(packet.direct_evidence.length, 2);
  assert.equal(packet.retrieval_policy.limit, 2);
});

test("buildGraphContext: cross-vault endpoints stay as edge refs without a nodes entry", () => {
  const context = buildGraphContext([
    {
      depth: 1,
      edge: { id: "e1", type: "has_premise", from: "goal:s:a", to: "vault:billing/deliverable:billing:v2" },
      from: { id: "goal:s:a", type: "Goal", title: "A" },
      to: undefined // ローカルに実体が無い cross-vault 参照
    }
  ]);
  assert.equal(context.edges[0].to, "vault:billing/deliverable:billing:v2");
  assert.ok(context.nodes["goal:s:a"]);
  assert.equal(Object.keys(context.nodes).length, 1);
});
