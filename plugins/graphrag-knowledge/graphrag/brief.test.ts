import assert from "node:assert/strict";
import test from "node:test";
import { buildRepeatGuidance, judgeMatchConfidence, buildGraphBrief, buildResumeBrief } from "./brief.ts";
import { buildVaultFiles } from "./build-vault.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("query brief errors when the vector index is absent (semantic required)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "brief-noidx-"));
  const vaultDir = path.join(root, "v");
  for (const f of buildVaultFiles({
    nodes: [{ id: "decision:s:x", type: "Decision", title: "X" }], edges: []
  })) {
    const abs = path.join(vaultDir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  try {
    await assert.rejects(
      () => buildGraphBrief({ mode: "query", query: "X", graph: vaultDir }),
      /vector index not found/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("judgeMatchConfidence returns 'none' when match is missing", () => {
  assert.equal(judgeMatchConfidence(undefined), "none");
});

// R4: vector と lexical を独立に判定し強い方を採る (旧「vector があれば vector のみ」廃止)。
// vector の絶対値バンドは baseline 無しフォールバック (high ≥0.83 / low ≥0.78)。
test("judgeMatchConfidence takes the stronger of vector / lexical signal", () => {
  // vector 単独 high (ngram は弱い) → high
  assert.equal(judgeMatchConfidence({ reasons: ["vector:0.85", "ngram:0.10"] }), "high");
  // vector low だが ngram high → 強い方 (ngram) を採って high
  assert.equal(judgeMatchConfidence({ reasons: ["vector:0.79", "ngram:0.80"] }), "high");
  // vector none + ngram high → ngram 側を採って high
  assert.equal(judgeMatchConfidence({ reasons: ["vector:0.30", "ngram:0.80"] }), "high");
  // 両方とも弱い → none
  assert.equal(judgeMatchConfidence({ reasons: ["vector:0.30", "ngram:0.10"] }), "none");
});

test("judgeMatchConfidence falls back to ngram when vector is absent", () => {
  assert.equal(judgeMatchConfidence({ reasons: ["ngram:0.70"] }), "high");
  assert.equal(judgeMatchConfidence({ reasons: ["ngram:0.50"] }), "low");
  assert.equal(judgeMatchConfidence({ reasons: ["ngram:0.30"] }), "none");
});

test("judgeMatchConfidence returns 'none' when no usable signal", () => {
  assert.equal(judgeMatchConfidence({ reasons: ["role:source×1.2"] }), "none");
  assert.equal(judgeMatchConfidence({ reasons: [] }), "none");
});

test("buildRepeatGuidance treats undefined and small N as 'fresh'", () => {
  assert.equal(buildRepeatGuidance(undefined).repeat_state, "fresh");
  assert.equal(buildRepeatGuidance(0).repeat_state, "fresh");
  assert.equal(buildRepeatGuidance(1).repeat_state, "fresh");
});

test("buildRepeatGuidance marks N=2 as 'followup' without escalation message", () => {
  const guidance = buildRepeatGuidance(2);
  assert.equal(guidance.repeat_state, "followup");
  assert.equal(guidance.message, null);
});

test("buildRepeatGuidance marks N>=3 as 'excessive' with switchover message", () => {
  const guidance = buildRepeatGuidance(3);
  assert.equal(guidance.repeat_state, "excessive");
  assert.match(guidance.message ?? "", /graph-external sources/);
});

function nodesById(graph) {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

// 既知バグの再現: dev-vault の全 Investigation は state 無しで、resume は黙って空振りしていた。
// 大声原則 — 空を返すなら理由 (state 無し旧データの存在) を一緒に返す。
test("resume reports legacy stateless Investigations instead of silently returning empty", () => {
  const graph = {
    nodes: [
      { id: "investigation:s:old1", type: "Investigation", title: "旧調査1" }, // state 無し
      { id: "investigation:s:old2", type: "Investigation", title: "旧調査2" }, // state 無し
      { id: "decision:s:x", type: "Decision", title: "X" }
    ],
    edges: []
  };
  const resume = buildResumeBrief(graph, nodesById(graph));
  assert.equal(resume.active_count, 0, "state==='active' フィルタは維持 (旧データを active 扱いしない)");
  assert.equal(resume.primary, null);
  assert.equal(resume.legacy_stateless_investigations, 2);
  assert.match(resume.legacy_note, /stateless/i);
  assert.match(resume.legacy_note, /2 stateless Investigation/i);
});

test("resume omits the legacy notice when an active Investigation exists", () => {
  const graph = {
    nodes: [
      { id: "investigation:s:live", type: "Investigation", title: "現役", state: "active" },
      { id: "investigation:s:old", type: "Investigation", title: "旧" } // state 無し
    ],
    edges: []
  };
  const resume = buildResumeBrief(graph, nodesById(graph));
  assert.equal(resume.active_count, 1);
  assert.equal(resume.primary.id, "investigation:s:live");
  assert.ok(!("legacy_stateless_investigations" in resume), "active が居れば注記しない");
});

test("resume stays plainly empty when there are no Investigations at all", () => {
  const graph = { nodes: [{ id: "decision:s:x", type: "Decision", title: "X" }], edges: [] };
  const resume = buildResumeBrief(graph, nodesById(graph));
  assert.equal(resume.active_count, 0);
  assert.ok(!("legacy_stateless_investigations" in resume));
});

test("resume does not count closed Investigations as legacy stateless", () => {
  const graph = {
    nodes: [{ id: "investigation:s:done", type: "Investigation", title: "終結", state: "closed" }],
    edges: []
  };
  const resume = buildResumeBrief(graph, nodesById(graph));
  assert.equal(resume.active_count, 0);
  assert.ok(!("legacy_stateless_investigations" in resume), "closed は意図的な終端、注記不要");
});

// 棚卸し誘導: state 無しレガシーが混じる、または active が溜まり気味なら stocktake_hint を出す。
test("resume adds stocktake_hint when stateless Investigations coexist", () => {
  const graph = {
    nodes: [
      { id: "investigation:s:live", type: "Investigation", title: "現役", state: "active" },
      { id: "investigation:s:old", type: "Investigation", title: "旧" } // state 無し
    ],
    edges: []
  };
  const resume = buildResumeBrief(graph, nodesById(graph));
  assert.match(resume.stocktake_hint, /stocktake/);
  assert.match(resume.stocktake_hint, /1 stateless Investigation/);
});

test("resume adds stocktake_hint when active piles up (>= 3)", () => {
  const graph = {
    nodes: [
      { id: "investigation:s:a", type: "Investigation", title: "a", state: "active" },
      { id: "investigation:s:b", type: "Investigation", title: "b", state: "active" },
      { id: "investigation:s:c", type: "Investigation", title: "c", state: "active" }
    ],
    edges: []
  };
  const resume = buildResumeBrief(graph, nodesById(graph));
  assert.match(resume.stocktake_hint, /3 active/);
});

test("resume omits stocktake_hint when healthy (1-2 active, no stateless)", () => {
  const graph = {
    nodes: [
      { id: "investigation:s:a", type: "Investigation", title: "a", state: "active" },
      { id: "investigation:s:b", type: "Investigation", title: "b", state: "active" }
    ],
    edges: []
  };
  const resume = buildResumeBrief(graph, nodesById(graph));
  assert.ok(!("stocktake_hint" in resume), "健全なら埋め草を出さない");
});

// compact 退避/復元: 複数 active があるとき、最新 checkpoint (generated_at が新しい) が primary。
// 旧実装は書かれない updated_at で空振りし id 順に決めていた — generated_at 実キーで最新に向く。
test("resume primary is the most recently checkpointed active Investigation (generated_at desc)", () => {
  const graph = {
    nodes: [
      // id 順では aaa が先頭だが generated_at は zzz が最新 → zzz が primary であるべき。
      { id: "investigation:s:aaa", type: "Investigation", title: "古い focus", state: "active",
        generated_at: "2026-07-01T00:00:00.000Z" },
      { id: "investigation:s:zzz", type: "Investigation", title: "直近 checkpoint", state: "active",
        generated_at: "2026-07-05T00:00:00.000Z" }
    ],
    edges: []
  };
  const resume = buildResumeBrief(graph, nodesById(graph));
  assert.equal(resume.active_count, 2);
  assert.equal(resume.primary.id, "investigation:s:zzz", "generated_at が最新のものが primary");
});

// A (退避): 作業状態は Investigation.raw_content に載り、resume が work_state として surface する。
test("resume surfaces the Investigation raw_content as work_state", () => {
  const graph = {
    nodes: [
      { id: "investigation:s:live", type: "Investigation", title: "現役", state: "active",
        raw_content: "current focus: X を実装中\nnext: Y を直す\nblocker: Z 待ち" }
    ],
    edges: []
  };
  const resume = buildResumeBrief(graph, nodesById(graph));
  assert.match(resume.primary.work_state ?? "", /current focus: X を実装中/);
  assert.match(resume.primary.work_state ?? "", /next: Y を直す/);
});

// B への到達: この focus が生んだ恒久知識に、Decision 以外 (Risk 等) も derived_from 経由で届く。
// 旧実装は Decision 限定だったため Risk/OK は「文章しか思い出せない」状態だった。
test("resume surfaces linked knowledge beyond Decision via derived_from (Risk/OK reachable)", () => {
  const graph = {
    nodes: [
      { id: "investigation:s:live", type: "Investigation", title: "現役", state: "active" },
      { id: "decision:s:d1", type: "Decision", title: "採用した判断" },
      { id: "risk:s:r1", type: "Risk", title: "踏んだリスク" },
      { id: "ok:s:o1", type: "OperationalKnowledge", title: "運用ハマり" }
    ],
    edges: [
      // checkpoint の標準配線: 知識 → Investigation (derived_from) + led_to (Investigation→Decision)。
      { id: "e1", type: "led_to", from: "investigation:s:live", to: "decision:s:d1" },
      { id: "e2", type: "derived_from", from: "risk:s:r1", to: "investigation:s:live" },
      { id: "e3", type: "derived_from", from: "ok:s:o1", to: "investigation:s:live" }
    ]
  };
  const resume = buildResumeBrief(graph, nodesById(graph));
  const ids = resume.primary.linked_knowledge.map((l) => l.node.id);
  assert.ok(ids.includes("decision:s:d1"), "Decision が届く");
  assert.ok(ids.includes("risk:s:r1"), "Risk も derived_from 経由で届く");
  assert.ok(ids.includes("ok:s:o1"), "OperationalKnowledge も届く");
});

// 深い生ログは discussed_in の ConversationChunk 側。resume は scratch ポインタとして surface。
test("resume surfaces the discussed_in ConversationChunk as a scratch pointer", () => {
  const graph = {
    nodes: [
      { id: "investigation:s:live", type: "Investigation", title: "現役", state: "active" },
      { id: "conversationchunk:s:c1", type: "ConversationChunk", title: "生ログ" }
    ],
    edges: [
      { id: "e1", type: "discussed_in", from: "conversationchunk:s:c1", to: "investigation:s:live" }
    ]
  };
  const resume = buildResumeBrief(graph, nodesById(graph));
  const ids = resume.primary.scratch.map((l) => l.node.id);
  assert.ok(ids.includes("conversationchunk:s:c1"), "discussed_in の ConversationChunk が scratch に出る");
});

// --- query brief: relations の slim 化 / 優先度 / standout 露出 ---

import { buildQueryBrief } from "./brief.ts";

function queryBriefFixture() {
  const long = "あ".repeat(300);
  const graph = {
    nodes: [
      { id: "decision:s:hit", type: "Decision", title: "認証基盤", summary: "hit" },
      { id: "decision:s:hit2", type: "Decision", title: "認証基盤", summary: "hit2" },
      { id: "risk:s:shared", type: "Risk", title: "共有リスク", summary: long },
      { id: "file:s:doc", type: "File", title: "doc.md", path: "doc.md" },
      { id: "decision:s:succ", type: "Decision", title: "後継", summary: "successor" }
    ],
    edges: [
      // hit の relations: documented_by (出所系) をグラフ順で先に置き、
      // supersedes (背骨) が優先ソートで先頭に来ることを確認する
      { id: "e1", type: "documented_by", from: "decision:s:hit", to: "file:s:doc" },
      { id: "e2", type: "supersedes", from: "decision:s:succ", to: "decision:s:hit" },
      { id: "e3", type: "has_premise", from: "decision:s:hit", to: "risk:s:shared" },
      // hit2 も同じ risk を参照 → 2 回目は id 参照に落ちる
      { id: "e4", type: "has_premise", from: "decision:s:hit2", to: "risk:s:shared" },
      // 未解決 cross-vault 参照 → stub {relation, direction, to}
      { id: "e5", type: "has_premise", from: "decision:s:hit", to: "vault:billing/deliverable:billing:v2" }
    ]
  };
  return { graph, nodesById: new Map(graph.nodes.map((n) => [n.id, n])) };
}

async function runQueryBrief(graph, nodesById) {
  return buildQueryBrief(graph, nodesById, {
    query: "認証基盤",
    vectorIndex: { provider: "fake", rows: [] },
    queryVectors: [[0]],
    limit: 5,
    relationLimit: 8
  });
}

test("query brief: relations are priority-sorted, dedup nodes by id, keep cross-vault stubs", async () => {
  const { graph, nodesById } = queryBriefFixture();
  const out = await runQueryBrief(graph, nodesById);
  const byId = new Map(out.matches.map((m) => [m.node.id, m]));
  const hit = byId.get("decision:s:hit");
  const hit2 = byId.get("decision:s:hit2");

  // 優先度: supersedes → has_premise (×2: risk + cross-vault stub) → documented_by
  assert.deepEqual(hit.relations.map((r) => r.relation),
    ["supersedes", "has_premise", "has_premise", "documented_by"]);

  // cross-vault stub は {relation, direction, to} で落とさず出す (xref-resolver が拾う)
  const stub = hit.relations.find((r) => typeof r.to === "string");
  assert.ok(stub, "未解決 cross-vault 参照は stub として出る");
  assert.equal(stub.to, "vault:billing/deliverable:billing:v2");
  assert.equal(stub.direction, "out");
  assert.ok(!("node" in stub));

  // relation ノードの summary は 120 字に切られる
  const shared = hit.relations.find((r) => r.node?.id === "risk:s:shared")
    ?? hit2.relations.find((r) => r.node?.id === "risk:s:shared");
  assert.ok(shared, "risk は初出でノード詳細つき");
  assert.ok(shared.node.summary.length <= 120, `関連ノード要約は ~120 字 (got ${shared.node.summary.length})`);

  // 2 回目の出現は {relation, direction, id} のみ
  const dedup = [...hit.relations, ...hit2.relations].filter(
    (r) => r.id === "risk:s:shared" || r.node?.id === "risk:s:shared"
  );
  assert.equal(dedup.length, 2);
  assert.equal(dedup.filter((r) => r.node).length, 1, "詳細は 1 回だけ");
  assert.equal(dedup.filter((r) => r.id && !r.node).length, 1, "2 回目は id 参照");

  // match ノード自身への relation も id 参照 (matches[].node に全文があるため)
  const succEntry = hit.relations.find((r) => r.relation === "supersedes");
  assert.ok(succEntry.node?.id === "decision:s:succ" || succEntry.id === "decision:s:succ");
});

test("query brief: null fields are omitted from compact nodes", async () => {
  const { graph, nodesById } = queryBriefFixture();
  const out = await runQueryBrief(graph, nodesById);
  const node = out.matches[0].node;
  assert.ok(!("path" in node), "path: null を撒かない");
  assert.ok(!("state" in node), "state: null を撒かない");
});

test("query brief exposes standout (relative gap) next to match_confidence", async () => {
  const { graph, nodesById } = queryBriefFixture();
  const out = await runQueryBrief(graph, nodesById);
  assert.ok(out.standout, "standout を露出する (world_hints と同じ思想)");
  assert.ok(["clear", "none", "single"].includes(out.standout.state));
  assert.ok("gap_above_next" in out.standout);
});

test("resume: planned/active Goal が open_goals として古い順に浮上する (無ければキー自体なし)", () => {
  const graph = {
    nodes: [
      { id: "goal:s:newer", type: "Goal", title: "新しい予約", state: "planned", generated_at: "2026-07-10T00:00:00.000Z" },
      { id: "goal:s:older", type: "Goal", title: "古い予約", state: "planned", generated_at: "2026-06-01T00:00:00.000Z" },
      { id: "goal:s:doing", type: "Goal", title: "進行中", state: "active", generated_at: "2026-07-01T00:00:00.000Z" },
      { id: "goal:s:done", type: "Goal", title: "済み", state: "achieved", generated_at: "2026-05-01T00:00:00.000Z" },
      { id: "goal:s:nostate", type: "Goal", title: "state なし" }
    ],
    edges: []
  };
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = buildResumeBrief(graph, nodesById);
  assert.equal(out.open_goals.count, 3, "planned/active のみ (achieved / state 無しは含めない)");
  assert.deepEqual(
    out.open_goals.oldest_first.map((g) => g.id),
    ["goal:s:older", "goal:s:doing", "goal:s:newer"],
    "古い順 — 一番忘れられているものが先頭"
  );
  const empty = buildResumeBrief({ nodes: [], edges: [] }, new Map());
  assert.equal("open_goals" in empty, false, "出す時だけ出す (null 埋め禁止)");
});
