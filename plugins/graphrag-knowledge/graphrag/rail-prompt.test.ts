import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { filterPromptText, pickInjectable, railPrompt } from "./rail-prompt.ts";
import {
  appendRailSeen, composeRailContext, loadRailSeen, sanitizeSessionId,
  RAIL_MAX_ITEMS, RAIL_TOTAL_BUDGET_CHARS
} from "./rail-common.ts";

// ── filterPromptText: 機械生成メッセージ・信号ゼロは沈黙 ──────────────────────

test("filterPromptText: 実プロンプトは通し、機械生成クラスは理由付きで落とす", () => {
  assert.equal(filterPromptText("checkpoint の復元が効かないので調べたい"), null);
  assert.equal(filterPromptText("短い"), "too-short");
  assert.equal(filterPromptText("/graphrag-knowledge:graphrag-checkpoint"), "slash-command");
  assert.equal(filterPromptText("<system-reminder>..."), "markup");
  assert.equal(filterPromptText("[SYSTEM NOTIFICATION - NOT USER INPUT] ..."), "markup");
  assert.equal(filterPromptText("Caveat: The messages below were generated..."), "caveat");
  assert.equal(filterPromptText("Base directory for this skill: /Users/k/.claude/plugins/..."), "skill-preamble");
  assert.equal(filterPromptText("Another Claude session sent a message: <teammate-message ...>"), "teammate-message");
  assert.equal(filterPromptText("This session is being continued from a previous conversation..."), "session-continuation");
});

// ── pickInjectable: seen 除外と cap ──────────────────────────────────────────

test("pickInjectable: seen のノードを除外し、RAIL_MAX_ITEMS でキャップする", () => {
  const matches = ["a", "b", "c", "d", "e"].map((s) => ({
    node: { id: `decision:s:${s}`, type: "Decision", title: `title ${s}`, summary: `summary ${s}` }
  }));
  const items = pickInjectable(matches, new Set(["decision:s:b"]));
  assert.equal(items.length, RAIL_MAX_ITEMS);
  assert.deepEqual(items.map((i) => i.id), ["decision:s:a", "decision:s:c", "decision:s:d"]);
  assert.equal(items[0].headline, "summary a");
});

test("pickInjectable: state を保持する (superseded は superseded と見えることに価値がある)", () => {
  const items = pickInjectable(
    [{ node: { id: "decision:s:x", type: "Decision", title: "t", state: "superseded" } }],
    new Set()
  );
  assert.equal(items[0].state, "superseded");
});

// ── composeRailContext: 注入予算の強制 ───────────────────────────────────────

test("composeRailContext: title/headline はクリップされ、合計予算超過なら件数を削って収める", () => {
  const long = "こ".repeat(300);
  const items = ["a", "b", "c"].map((s) => ({ id: s, type: "Decision", title: long, headline: long }));
  const longHeader = "h".repeat(180); // クリップ後の3件 (~570字) + このヘッダで予算 700 を超えさせる
  const composed = composeRailContext("graphrag prompt rail", longHeader, items);
  assert.ok(composed, "1件は収まるはず");
  assert.ok(composed!.chars <= RAIL_TOTAL_BUDGET_CHARS, `budget: ${composed!.chars}`);
  assert.ok(composed!.ids.length < 3, "件数が削られている");
  assert.ok(!composed!.context.includes(long), "300字の title が素通りしていない (クリップ済み)");
});

test("composeRailContext: 空なら null (沈黙)", () => {
  assert.equal(composeRailContext("t", "h", []), null);
});

// ── seen-set: セッション別ファイルの roundtrip ────────────────────────────────

test("rail-seen: セッション別ファイルに追記・読込でき、別セッションと混ざらない", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grag-rail-seen-"));
  appendRailSeen(dir, "sess1", { nodeIds: ["n1"], list: "touch", files: ["f1.ts"] });
  appendRailSeen(dir, "sess2", { nodeIds: ["n2"] });
  assert.deepEqual(loadRailSeen(dir, "sess1").injected_node_ids, ["n1"]);
  assert.deepEqual(loadRailSeen(dir, "sess1").touched_files, ["f1.ts"]);
  assert.deepEqual(loadRailSeen(dir, "sess2").injected_node_ids, ["n2"]);
  assert.deepEqual(loadRailSeen(dir, "sess3").injected_node_ids, []);
});

test("rail-seen: append-only なので交互の load→append で更新が消えない (並列 Read 相当)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grag-rail-seen-race-"));
  // 旧実装 (read-modify-write) では A/B が同時に load した後の save で last-writer-wins に
  // なり片方の記録が消えた。append-only では両方残る。
  loadRailSeen(dir, "sess"); // A が load (空)
  loadRailSeen(dir, "sess"); // B が load (空)
  appendRailSeen(dir, "sess", { list: "read", files: ["a.ts"], nodeIds: ["nA"] }); // A が書く
  appendRailSeen(dir, "sess", { list: "read", files: ["b.ts"], nodeIds: ["nB"] }); // B が書く
  const merged = loadRailSeen(dir, "sess");
  assert.deepEqual(merged.read_files.sort(), ["a.ts", "b.ts"]);
  assert.deepEqual(merged.injected_node_ids.sort(), ["nA", "nB"]);
});

test("rail-seen: 旧形式 .json (v1.41.0 以前) も読み側で合流する (アップグレード互換)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grag-rail-seen-legacy-"));
  writeFileSync(
    path.join(dir, "rail-seen-old.json"),
    JSON.stringify({ injected_node_ids: ["legacy-node"], touched_files: ["t.ts"], read_files: ["r.ts"] })
  );
  appendRailSeen(dir, "old", { nodeIds: ["new-node"] });
  const seen = loadRailSeen(dir, "old");
  assert.deepEqual(seen.injected_node_ids.sort(), ["legacy-node", "new-node"]);
  assert.deepEqual(seen.touched_files, ["t.ts"]);
  assert.deepEqual(seen.read_files, ["r.ts"]);
});

test("sanitizeSessionId: ファイル名安全な形に落とし、空は null", () => {
  assert.equal(sanitizeSessionId("abc-123_XYZ"), "abc-123_XYZ");
  assert.equal(sanitizeSessionId("../../etc/passwd"), "etcpasswd");
  assert.equal(sanitizeSessionId("///"), null);
  assert.equal(sanitizeSessionId(undefined), null);
});

// ── railPrompt: fail-open (vault 不在で沈黙、例外を漏らさない) ─────────────────

test("railPrompt: vault が無い環境では brief-error で沈黙する (fail-open)", async () => {
  const prevVault = process.env.GRAPHRAG_VAULT_DIR;
  delete process.env.GRAPHRAG_VAULT_DIR;
  try {
    const r = await railPrompt("checkpoint の復元が効かないので調べたい", null);
    assert.equal(r.status, "silent");
  } finally {
    if (prevVault !== undefined) process.env.GRAPHRAG_VAULT_DIR = prevVault;
  }
});

test("railPrompt: フィルタ対象は brief を呼ぶ前に沈黙する", async () => {
  const r = await railPrompt("/graphrag-knowledge:graphrag-checkpoint を実行して", null);
  assert.deepEqual(r, { status: "silent", reason: "slash-command" });
});

// ── issue #36: 型名入り prompt の gate (元 query と型名除去 query の top1 一致時のみ注入) ──

import { stripTypeWords, typeWordGateAgrees } from "./rail-prompt.ts";
import { searchGraph } from "./retrieval.ts";
import { DEFAULT_SCHEMA } from "./schema.ts";
import { mkdirSync } from "node:fs";

const TYPES = DEFAULT_SCHEMA.nodeTypes;

test("stripTypeWords: 型名を単語境界 (和文直結も含む) で除き、型名が無ければ null", () => {
  assert.equal(stripTypeWords("vault フラグの Decision を見直したい", TYPES), "vault フラグの を見直したい");
  assert.equal(stripTypeWords("Decisionを見直す", TYPES), "を見直す");
  assert.equal(stripTypeWords("decisions の一覧", TYPES), null); // 部分一致はしない
  assert.equal(stripTypeWords("checkpoint の復元", TYPES), null);
  assert.equal(stripTypeWords("Decision", TYPES), null); // 型名だけなら比較不能
});

test("typeWordGateAgrees: top1 完全一致のみ一致。補助側の欠落は不一致", () => {
  assert.equal(typeWordGateAgrees("a", "a"), true);
  assert.equal(typeWordGateAgrees("a", "b"), false);
  assert.equal(typeWordGateAgrees("a", undefined), false);
  assert.equal(typeWordGateAgrees(undefined, undefined), false);
});

/** searchGraph を brief 相当に包む fake (全 query 同一 vector、node ごとの vector で semantic を与える)。 */
function fakeBrief(nodes: any[], vectors: Record<string, number[]>, calls: string[]) {
  const graph = { nodes, edges: [] };
  const vectorIndex = { rows: nodes.map((n) => ({ node_id: n.id, vector: vectors[n.id] ?? [1, 0] })) };
  return async (opts: any) => {
    calls.push(opts.query);
    const matches = searchGraph(graph, opts.query, { vectorIndex, queryVector: [1, 0], lexicalIndex: null, limit: 5 });
    return { query: { match_confidence: "high", matches } };
  };
}

test("gate: issue 再現 (EN/JA) — 元 query の誤 top1 は補助 query と食い違うので注入しない", async () => {
  const nodes = [
    { id: "decision:s:target", type: "Decision", title: "Embedding outage handling", summary: "ask output JSON processing issue 24 ask-format lexical-only 埋め込み障害の扱い" },
    { id: "operationalknowledge:s:distractor", type: "OperationalKnowledge", title: "Classification rules", summary: "Decision OperationalKnowledge Constraint classification rules" }
  ];
  for (const q of ["ask-format lexical-only OperationalKnowledge Decision の確認をしたい", "埋め込み障害の扱い ask-format lexical-only OperationalKnowledge Decision"]) {
    const r = await railPrompt(q, null, { brief: fakeBrief(nodes, {}, []), typeNames: TYPES });
    assert.deepEqual([r.status, r.reason], ["silent", "type-word-disagree"], q);
  }
});

test("gate: 型を問う prompt で補助 query が別分野に当たっても誤注入しない (Risk と Decision の使い分け + REST)", async () => {
  const nodes = [
    { id: "decision:s:distinction", type: "Decision", title: "Risk vs Decision distinction", summary: "when to record a Risk versus a Decision" },
    { id: "decision:s:api", type: "Decision", title: "REST と GraphQL の使い分け", summary: "API design guidelines" }
  ];
  const vectors = { "decision:s:distinction": [0.9, Math.sqrt(0.19)], "decision:s:api": [0.8, 0.6] };
  const r = await railPrompt("Risk と Decision の使い分けを整理したい", null, { brief: fakeBrief(nodes, vectors, []), typeNames: TYPES });
  assert.equal(r.status, "silent");
  assert.equal(r.reason, "type-word-disagree");
});

test("gate: Risk assessment / Cost assessment — 補助 query が区別できなければ黙る (誤注入より沈黙)", async () => {
  const nodes = [
    { id: "decision:s:cost", type: "Decision", title: "Cost assessment", summary: "assessment process" },
    { id: "decision:s:risk", type: "Decision", title: "Risk assessment", summary: "assessment process" }
  ];
  const r = await railPrompt("Risk assessment のやり方を確認したい", null, { brief: fakeBrief(nodes, {}, []), typeNames: TYPES });
  assert.notEqual(r.ids?.[0], "decision:s:cost");
});

test("gate: 両 query の top1 が一致すれば従来通り注入する (正解維持の対照)", async () => {
  const nodes = [
    { id: "decision:s:enforce", type: "Decision", title: "enforcement contract for constraints", summary: "enforced_by wiring is required" },
    { id: "decision:s:other", type: "Decision", title: "unrelated topic", summary: "something else" }
  ];
  const r = await railPrompt("Constraint の enforcement contract を変えたい", null, { brief: fakeBrief(nodes, {}, []), typeNames: TYPES });
  assert.equal(r.status, "inject");
  assert.equal(r.ids?.[0], "decision:s:enforce");
});

test("gate の限界: 両 query が同じ誤 top1 に一致すると抑止できない (既知の制約)", async () => {
  const nodes = [
    { id: "operationalknowledge:s:wrong", type: "OperationalKnowledge", title: "vault flag history notes", summary: "vault flag history" }
  ];
  const r = await railPrompt("vault flag の Decision を見直したい", null, { brief: fakeBrief(nodes, {}, []), typeNames: TYPES });
  assert.equal(r.status, "inject");
  assert.equal(r.ids?.[0], "operationalknowledge:s:wrong");
});

test("gate: 型名を含まない prompt は追加検索しない / 補助検索の失敗は不一致扱い", async () => {
  const nodes = [{ id: "decision:s:a", type: "Decision", title: "checkpoint restore", summary: "checkpoint restore flow" }];
  const calls: string[] = [];
  const r = await railPrompt("checkpoint の restore を確認したい", null, { brief: fakeBrief(nodes, {}, calls), typeNames: TYPES });
  assert.equal(r.status, "inject");
  assert.equal(calls.length, 1);

  let n = 0;
  const flaky = async (opts: any) => {
    n += 1;
    if (n === 2) throw new Error("aux timeout");
    return fakeBrief(nodes, {}, [])(opts);
  };
  const r2 = await railPrompt("checkpoint restore の Decision を確認したい", null, { brief: flaky, typeNames: TYPES });
  assert.deepEqual([r2.status, r2.reason], ["silent", "type-word-disagree"]);
});

test("gate: 型名は active schema から取る (project preset の Stakeholder も補助 query で除く)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "railschema-"));
  mkdirSync(path.join(root, "vault"));
  writeFileSync(path.join(root, "VAULT.md"), "---\nschema: project\n---\n");
  const prev = process.env.GRAPHRAG_VAULT_DIR;
  process.env.GRAPHRAG_VAULT_DIR = path.join(root, "vault");
  try {
    const nodes = [{ id: "stakeholder:s:a", type: "Stakeholder", title: "vendor contact", summary: "vendor contact owner" }];
    const calls: string[] = [];
    await railPrompt("vendor contact の Stakeholder を確認したい", null, { brief: fakeBrief(nodes, {}, calls) });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].includes("Stakeholder"), false);
  } finally {
    if (prev === undefined) delete process.env.GRAPHRAG_VAULT_DIR; else process.env.GRAPHRAG_VAULT_DIR = prev;
  }
});
