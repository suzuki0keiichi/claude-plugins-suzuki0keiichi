import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { searchGraph } from "./retrieval.ts";
import {
  LEXICAL_INDEX_VERSION,
  buildLexicalIndex,
  computeLexicalFingerprint,
  defaultLexicalIndexPath,
  lexicalIndexFromPayload,
  lexicalIndexToPayload,
  loadLexicalIndex
} from "./lexical-index.ts";

// issue #33: searchGraph の永続転置 index (posting list) 経路は、従来の
// per-node 正規化/ngram 生成経路と「順序・score・reasons・state_note まで」
// 完全同値でなければならない。ここはその同値性を deepEqual で固定する。

// 多様性 fixture: CJK / latin / JA+EN 併記 / alias (全角・exact) / tags /
// display 入れ子 / File role / 終端 state / TYPE_BOOST 型 / 同点 tie-break /
// 1 文字 CJK 語 / 短 latin 語の部分一致 (posting に乗らない includes 経路)。
function fixtureGraph() {
  return {
    nodes: [
      {
        id: "decision:sys:dup-check",
        type: "Decision",
        title: "重複チェックの設計判断",
        summary: "duplicate check は builder 側で行う",
        aliases: ["duplicate-check", "重複検査"],
        tags: ["design", "builder"]
      },
      { id: "decision:sys:auth", type: "Decision", title: "認証基盤", summary: "auth is centralized", state: "superseded" },
      { id: "conv:sys:auth-log", type: "ConversationChunk", title: "認証の議論ログ", summary: "認証 基盤 の長い会話の記録" },
      { id: "file:src/auth.ts", type: "File", title: "auth.ts", path: "src/auth.ts", role: "source", summary: "認証 実装" },
      { id: "file:test/auth.test.ts", type: "File", title: "auth.test.ts", path: "test/auth.test.ts", role: "test", summary: "認証 テスト" },
      { id: "inv:sys:zu", type: "Investigation", title: "図の索引調査", summary: "図 を索引する", state: "closed" },
      { id: "know:sys:about", type: "OperationalKnowledge", title: "about page cache", summary: "the about page caches aggressively" },
      { id: "goal:sys:tie-a", type: "Goal", title: "同点タイ", summary: "全く同じ内容" },
      { id: "goal:sys:tie-b", type: "Goal", title: "同点タイ", summary: "全く同じ内容" },
      { id: "know:sys:zenkaku", type: "OperationalKnowledge", title: "グラフサーチ最適化", aliases: ["ｸﾞﾗﾌｻｰﾁ"] },
      {
        id: "risk:sys:display",
        type: "Risk",
        title: "表示リスク",
        display: { sections: [{ text: "配線整合の検査" }, { items: ["walker", "突合"] }] }
      },
      { id: "note:sys:empty", type: "Assumption", title: "", summary: "" }
    ],
    edges: [
      { id: "e1", type: "refines", from: "decision:sys:auth", to: "conv:sys:auth-log" },
      { id: "e2", type: "constrains", from: "decision:sys:auth", to: "file:src/auth.ts" },
      { id: "e3", type: "documented_by", from: "file:src/auth.ts", to: "file:test/auth.test.ts" }
    ]
  };
}

function fixtureVectorIndex() {
  return {
    rows: [
      { node_id: "decision:sys:auth", vector: [1, 0, 0] },
      { node_id: "conv:sys:auth-log", vector: [0.6, 0.8, 0] },
      { node_id: "file:src/auth.ts", vector: [0, 1, 0] },
      { node_id: "know:sys:about", vector: [0, 0, 1] },
      { node_id: "risk:sys:display", vector: [0.8, 0, 0.6] }
    ]
  };
}

// 同値性を張るクエリ×オプションの組。空振り同士 ([] === []) の空虚な一致に
// ならないよう、mustMatch: true の組は従来経路が 1 件以上返すことも検証する。
function equivalenceCases() {
  const vectorIndex = fixtureVectorIndex();
  return [
    { query: "認証", options: {}, mustMatch: true },
    { query: "duplicate check 重複", options: {}, mustMatch: true },          // JA+EN 併記
    { query: "ｸﾞﾗﾌｻｰﾁ", options: {}, mustMatch: true },                       // 全角 alias exact
    { query: "図", options: {}, mustMatch: true },                            // 1 文字 CJK (query gram なし)
    { query: "ab", options: {}, mustMatch: true },                            // 短 latin: "about" への部分一致
    { query: "なぜ 重複 チェック を した", options: {}, mustMatch: true },    // 機能語混じり
    { query: "配線 整合", options: {}, mustMatch: true },                     // display 入れ子
    { query: "walker", options: {}, mustMatch: true },
    { query: "認証", options: { types: ["Decision"] }, mustMatch: true },
    { query: "同点タイ", options: {}, mustMatch: true },                      // tie-break (id 順)
    { query: "同点タイ", options: { limit: 1 }, mustMatch: true },
    { query: "存在しない語彙xyzzy", options: {}, mustMatch: false },
    { query: "認証 基盤", options: { vectorIndex, queryVector: [1, 0, 0] }, mustMatch: true },
    { query: "認証", options: { vectorIndex, queryVectors: [[1, 0, 0], [0, 1, 0]] }, mustMatch: true },
    { query: "cache", options: { vectorIndex, queryVector: [0, 0, 1] }, mustMatch: true },
    { query: "認証", options: { graphRerank: true }, mustMatch: true },
    { query: "auth", options: { roleWeights: false }, mustMatch: true },
    { query: "auth", options: { roleWeights: { test: 2 } }, mustMatch: true }
  ];
}

function assertEquivalent(graph, lexicalIndex, label = "") {
  for (const { query, options, mustMatch } of equivalenceCases()) {
    const legacy = searchGraph(graph, query, { ...options });
    const indexed = searchGraph(graph, query, { ...options, lexicalIndex });
    if (mustMatch) {
      assert.ok(legacy.length > 0, `${label} legacy が空振り (空虚な同値): query=${query}`);
    }
    assert.deepEqual(indexed, legacy, `${label} 同値性が崩れた: query=${query} options=${JSON.stringify(options)}`);
  }
}

test("転置 index 経由の searchGraph は従来計算と完全同値 (順序・score・reasons・state_note)", () => {
  const graph = fixtureGraph();
  const index = buildLexicalIndex(graph);
  assert.ok(index, "fixture から転置 index を構築できる");
  assertEquivalent(graph, index, "[in-memory]");
});

test("転置 index: JSON 直列化往復後も従来計算と完全同値", () => {
  const graph = fixtureGraph();
  const index = buildLexicalIndex(graph);
  const fingerprint = computeLexicalFingerprint(graph);
  const payload = JSON.parse(JSON.stringify(lexicalIndexToPayload(index, fingerprint)));
  assert.equal(payload.version, LEXICAL_INDEX_VERSION);
  assert.equal(payload.graph_fingerprint, fingerprint);
  const revived = lexicalIndexFromPayload(payload);
  assertEquivalent(graph, revived, "[roundtrip]");
});

test("転置 index: state/type/role は graph から live に読む (cache 後の state 変更にも同値)", () => {
  const graph = fixtureGraph();
  const index = buildLexicalIndex(graph);
  const before = computeLexicalFingerprint(graph);
  // 検索フィールド外の変更 (state) は fingerprint を変えない — cache は使い続けてよく、
  // その場合でも減点/注記は live の state から正しく出る。
  const target = graph.nodes.find((node) => node.id === "goal:sys:tie-a");
  target.state = "abandoned";
  assert.equal(computeLexicalFingerprint(graph), before, "state は検索フィールドでないので fingerprint 不変");
  const legacy = searchGraph(graph, "同点タイ", {});
  const indexed = searchGraph(graph, "同点タイ", { lexicalIndex: index });
  assert.deepEqual(indexed, legacy);
  assert.ok(indexed.some((m) => m.state_note && m.node.id === "goal:sys:tie-a"), "state_note が live に付く");
});

test("computeLexicalFingerprint: 検索フィールド (summary/aliases/tags/display) の変更で変わる", () => {
  const base = computeLexicalFingerprint(fixtureGraph());
  const bySummary = fixtureGraph();
  bySummary.nodes[0].summary = "変更後の要約";
  assert.notEqual(computeLexicalFingerprint(bySummary), base);
  const byAlias = fixtureGraph();
  byAlias.nodes[0].aliases = ["renamed-alias"];
  assert.notEqual(computeLexicalFingerprint(byAlias), base);
  const byTags = fixtureGraph();
  byTags.nodes[0].tags = ["design"];
  assert.notEqual(computeLexicalFingerprint(byTags), base);
  const byDisplay = fixtureGraph();
  byDisplay.nodes.find((n) => n.id === "risk:sys:display").display.sections[0].text = "別の文言";
  assert.notEqual(computeLexicalFingerprint(byDisplay), base);
  const byRemoval = fixtureGraph();
  byRemoval.nodes.pop();
  assert.notEqual(computeLexicalFingerprint(byRemoval), base, "ノード削除も検出する");
});

test("buildLexicalIndex: 重複 node id の graph には null (呼び出し側は従来経路へ)", async () => {
  const dup = {
    nodes: [
      { id: "decision:sys:same", type: "Decision", title: "x" },
      { id: "decision:sys:same", type: "Decision", title: "y" }
    ],
    edges: []
  };
  assert.equal(buildLexicalIndex(dup), null);
  const root = mkdtempSync(path.join(tmpdir(), "lex-dup-"));
  const vaultDir = path.join(root, ".graphrag", "vault");
  mkdirSync(vaultDir, { recursive: true });
  const loaded = await loadLexicalIndex(vaultDir, dup);
  assert.equal(loaded, null, "loadLexicalIndex も null (crash しない)");
  // lexicalIndex なし = 従来経路そのもの
  const matches = searchGraph(dup, "x", {});
  assert.ok(matches.length > 0);
});

test("loadLexicalIndex: 初回は構築+永続化し、2回目は永続 index を実際に使う (sentinel 検証)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lex-load-"));
  const vaultDir = path.join(root, ".graphrag", "vault");
  mkdirSync(vaultDir, { recursive: true });
  const graph = fixtureGraph();

  const first = await loadLexicalIndex(vaultDir, graph);
  assert.ok(first, "初回ロードで in-memory 構築が返る");
  assertEquivalent(graph, first, "[first-load]");

  const indexPath = defaultLexicalIndexPath(vaultDir);
  assert.ok(existsSync(indexPath), "転置 index が永続化される");
  const payload = JSON.parse(readFileSync(indexPath, "utf8"));
  assert.equal(payload.graph_fingerprint, computeLexicalFingerprint(graph));

  // sentinel: 永続ファイル側の haystack だけを改竄する (fingerprint は据え置き)。
  // 再ロード後の検索が sentinel を拾えば、ファイルの index が実際に使われた証拠。
  const idx = payload.ids.indexOf("decision:sys:dup-check");
  assert.ok(idx >= 0);
  payload.nodes[idx].h += "\nsentineltoken";
  writeFileSync(indexPath, JSON.stringify(payload));

  const second = await loadLexicalIndex(vaultDir, graph);
  const hits = searchGraph(graph, "sentineltoken", { lexicalIndex: second });
  assert.equal(hits[0]?.node.id, "decision:sys:dup-check", "永続 index 由来の haystack が検索に効いている");
  assert.ok(hits[0].reasons.includes("term:sentineltoken"), "sentinel が term 一致している = ファイル由来");
});

test("loadLexicalIndex: fingerprint 不一致 (graph 変更) は fallback 再計算 + index 再生成", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lex-stale-"));
  const vaultDir = path.join(root, ".graphrag", "vault");
  mkdirSync(vaultDir, { recursive: true });

  const original = fixtureGraph();
  await loadLexicalIndex(vaultDir, original);
  const indexPath = defaultLexicalIndexPath(vaultDir);
  const staleFingerprint = JSON.parse(readFileSync(indexPath, "utf8")).graph_fingerprint;

  // graph を変更 (summary に新語彙) → 旧 index は stale
  const changed = fixtureGraph();
  changed.nodes[0].summary = "novelphrase を含む変更後の要約";
  const runtime = await loadLexicalIndex(vaultDir, changed);
  assert.ok(runtime);

  // fallback 計算の結果は従来経路と同値で、新語彙も拾う
  assertEquivalent(changed, runtime, "[stale-fallback]");
  const hits = searchGraph(changed, "novelphrase", { lexicalIndex: runtime });
  assert.equal(hits[0]?.node.id, "decision:sys:dup-check");
  assert.ok(hits[0].reasons.includes("term:novelphrase"), "新語彙を term 一致で拾う = 再計算済み");

  // index は新 fingerprint で再生成されている
  const rewritten = JSON.parse(readFileSync(indexPath, "utf8"));
  assert.notEqual(rewritten.graph_fingerprint, staleFingerprint);
  assert.equal(rewritten.graph_fingerprint, computeLexicalFingerprint(changed));
});

test("loadLexicalIndex: 破損 index (JSON 破損 / 構造破損 / version 不一致) でも検索は成功し自己修復する", async () => {
  const graph = fixtureGraph();
  const corruptions: Array<[string, (indexPath: string, fingerprint: string) => void]> = [
    ["garbage json", (indexPath) => writeFileSync(indexPath, "{{{ not json")],
    ["malformed postings", (indexPath, fingerprint) => writeFileSync(indexPath, JSON.stringify({
      version: LEXICAL_INDEX_VERSION,
      graph_fingerprint: fingerprint,
      ids: ["a"],
      nodes: [{ h: "x", a: [] }],
      postings: "nope"
    }))],
    ["node entry not object", (indexPath, fingerprint) => writeFileSync(indexPath, JSON.stringify({
      version: LEXICAL_INDEX_VERSION,
      graph_fingerprint: fingerprint,
      ids: ["a"],
      nodes: ["broken"],
      postings: {}
    }))],
    ["unknown version", (indexPath, fingerprint) => writeFileSync(indexPath, JSON.stringify({
      version: 999,
      graph_fingerprint: fingerprint,
      ids: [],
      nodes: [],
      postings: {}
    }))]
  ];
  for (const [label, corrupt] of corruptions) {
    const root = mkdtempSync(path.join(tmpdir(), "lex-corrupt-"));
    const vaultDir = path.join(root, ".graphrag", "vault");
    mkdirSync(vaultDir, { recursive: true });
    const indexPath = defaultLexicalIndexPath(vaultDir);
    mkdirSync(path.dirname(indexPath), { recursive: true });
    corrupt(indexPath, computeLexicalFingerprint(graph));

    const runtime = await loadLexicalIndex(vaultDir, graph);
    assert.ok(runtime, `${label}: 破損でも runtime が返る`);
    assertEquivalent(graph, runtime, `[corrupt:${label}]`);
    const repaired = JSON.parse(readFileSync(indexPath, "utf8"));
    assert.equal(repaired.graph_fingerprint, computeLexicalFingerprint(graph), `${label}: 再生成される`);
    assert.equal(repaired.version, LEXICAL_INDEX_VERSION);
  }
});

test("loadLexicalIndex: 書き込み失敗 (cache dir がファイル) でも検索は失敗しない", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lex-nowrite-"));
  const stateDir = path.join(root, ".graphrag");
  mkdirSync(stateDir, { recursive: true });
  const vaultDir = path.join(stateDir, "vault");
  mkdirSync(vaultDir, { recursive: true });
  writeFileSync(path.join(stateDir, "cache"), "not a directory"); // mkdir/rename を確実に失敗させる

  const graph = fixtureGraph();
  const runtime = await loadLexicalIndex(vaultDir, graph);
  assert.ok(runtime, "書けなくても in-memory 構築で検索は続行する");
  assertEquivalent(graph, runtime, "[write-fail]");
});
