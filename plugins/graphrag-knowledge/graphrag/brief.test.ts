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
test("judgeMatchConfidence takes the stronger of vector / lexical signal", () => {
  // vector 単独 high (ngram は弱い) → high
  assert.equal(judgeMatchConfidence({ reasons: ["vector:0.72", "ngram:0.10"] }), "high");
  // vector low だが ngram high → 強い方 (ngram) を採って high
  assert.equal(judgeMatchConfidence({ reasons: ["vector:0.55", "ngram:0.80"] }), "high");
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
  assert.match(resume.legacy_note, /state 無し/);
  assert.match(resume.legacy_note, /2 件/);
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
