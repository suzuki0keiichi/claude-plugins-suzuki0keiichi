import assert from "node:assert/strict";
import test from "node:test";
import { searchGraph } from "./retrieval.ts";

// 完全一致のみ (別名一致) のノードと、意味だけ近いノードを用意し、
// 対等なスコアで競る (完全一致が突出しない) ことを確認する。
test("searchGraph: exact-match and semantic-only score on par (no exact dominance)", () => {
  const graph = {
    nodes: [
      // 別名がクエリと完全一致。ただし意味ベクトルは無関係 (直交)。
      { id: "n:exact", type: "Decision", title: "X", aliases: ["認証"] },
      // 別名一致なし。意味ベクトルがクエリと一致 (cosine=1)。
      { id: "n:semantic", type: "Decision", title: "ログイン基盤" }
    ],
    edges: []
  };
  const queryVector = [1, 0, 0];
  const vectorIndex = {
    rows: [
      { node_id: "n:exact", vector: [0, 1, 0] },     // 直交 → cosine 0
      { node_id: "n:semantic", vector: [1, 0, 0] }   // 一致 → cosine 1
    ]
  };
  const matches = searchGraph(graph, "認証", { vectorIndex, queryVector, limit: 10 });
  const byId = new Map(matches.map((m) => [m.node.id, m]));
  const exact = byId.get("n:exact").score;
  const semantic = byId.get("n:semantic").score;
  assert.ok(Math.abs(exact - semantic) <= 5,
    `exact(${exact}) と semantic(${semantic}) は対等であるべき`);
});

test("searchGraph: node matching both lexical and semantic outranks single-signal nodes", () => {
  const graph = {
    nodes: [
      { id: "n:both", type: "Decision", title: "認証" },        // 文字一致 + 意味一致
      { id: "n:lex", type: "Decision", title: "認証", aliases: [] },
      { id: "n:sem", type: "Decision", title: "ログイン" }
    ],
    edges: []
  };
  const queryVector = [1, 0];
  const vectorIndex = {
    rows: [
      { node_id: "n:both", vector: [1, 0] },
      { node_id: "n:lex", vector: [0, 1] },
      { node_id: "n:sem", vector: [1, 0] }
    ]
  };
  const matches = searchGraph(graph, "認証", { vectorIndex, queryVector, limit: 10 });
  assert.equal(matches[0].node.id, "n:both", "両方該当が最上位");
});

test("searchGraph: reasons still expose vector:/ngram: for confidence judging", () => {
  const graph = { nodes: [{ id: "n:1", type: "Decision", title: "認証基盤" }], edges: [] };
  const queryVector = [1, 0];
  const vectorIndex = { rows: [{ node_id: "n:1", vector: [1, 0] }] };
  const matches = searchGraph(graph, "認証", { vectorIndex, queryVector, limit: 10 });
  const reasons = matches[0].reasons.join(" ");
  assert.match(reasons, /vector:[0-9.]+/, "vector reason 維持 (confidence 用)");
  assert.match(reasons, /ngram:[0-9.]+/, "ngram reason 維持 (confidence 用)");
});

test("searchGraph works without a vector index (lexical only, ngram reason for confidence)", () => {
  const graph = { nodes: [{ id: "n:1", type: "Decision", title: "認証基盤" }], edges: [] };
  // vectorIndex / queryVector を渡さない (本番で索引が無い経路)
  const matches = searchGraph(graph, "認証", { limit: 10 });
  assert.equal(matches.length, 1);
  const reasons = matches[0].reasons.join(" ");
  assert.doesNotMatch(reasons, /vector:/, "索引無しなら vector reason は出ない");
  assert.match(reasons, /ngram:[0-9.]+/, "ngram reason は出る (confidence フォールバック)");
});

test("searchGraph applies File role weight as an auxiliary multiplier", () => {
  const graph = {
    nodes: [
      { id: "f:src", type: "File", title: "認証", role: "source" },
      { id: "f:test", type: "File", title: "認証", role: "test" }
    ],
    edges: []
  };
  // 同じ文字一致でも role が違う → source (weight 1) が test (0.55) より上位
  const matches = searchGraph(graph, "認証", { limit: 10 });
  assert.equal(matches[0].node.id, "f:src");
  assert.ok(matches[0].score > matches[1].score, "role weight が補助的に効く");
});

// --- R5 graph rerank ---
// 島構造: a/b/c は互いにエッジで繋がる (各 2 票)。d は孤立 (0 票)。初期スコアが d 最上位
// でも、rerank で繋がる島の候補が浮き、off なら浮かないことを決定論で確認する。
test("searchGraph: graph rerank floats edge-adjacent candidates (island), off keeps initial order", () => {
  const graph = {
    nodes: [
      { id: "n:a", type: "Decision", title: "認証" },
      { id: "n:b", type: "Decision", title: "認証" },
      { id: "n:c", type: "Decision", title: "認証" },
      { id: "n:d", type: "Decision", title: "認証基盤" } // わずかに長い → 初期 lexical で上
    ],
    edges: [
      { id: "e1", type: "refines", from: "n:a", to: "n:b" },
      { id: "e2", type: "refines", from: "n:b", to: "n:c" },
      { id: "e3", type: "refines", from: "n:c", to: "n:a" }
    ]
  };
  // rerank off: 初期スコア順 (島の隣接を考慮しない)
  const off = searchGraph(graph, "認証", { limit: 10, graphRerank: false });
  const offTop = off.map((m) => m.node.id);
  assert.ok(!offTop[0].startsWith("n:") || !off[0].reasons.some((r) => r.startsWith("graph:")),
    "off では graph reason が付かない");
  assert.ok(off.every((m) => !m.reasons.some((r) => r.startsWith("graph:"))), "off では一切 rerank しない");

  // rerank on (opt-in。既定は off — 実 vault 実測で hub 偏重 net-negative のため): 島の a/b/c が各 2 票で +12% 浮く。
  const on = searchGraph(graph, "認証", { limit: 10, graphRerank: true });
  // 既定 (オプション無指定) は off と同じ = graph reason が付かない
  const def = searchGraph(graph, "認証", { limit: 10 });
  assert.ok(def.every((m) => !m.reasons.some((r) => r.startsWith("graph:"))), "既定は rerank off");
  const byId = new Map(on.map((m) => [m.node.id, m]));
  assert.ok(byId.get("n:a").reasons.includes("graph:+2"), "島メンバは graph:+2 を得る");
  assert.ok(byId.get("n:b").reasons.includes("graph:+2"));
  assert.ok(byId.get("n:c").reasons.includes("graph:+2"));
  assert.ok(!byId.get("n:d").reasons.some((r) => r.startsWith("graph:")), "孤立ノードは票なし");
  // 島の 3 ノードは孤立 d より上位 (rerank で浮く)
  const onTop3 = on.slice(0, 3).map((m) => m.node.id).sort();
  assert.deepEqual(onTop3, ["n:a", "n:b", "n:c"], "島の 3 候補が上位を占める");
});

test("searchGraph: graph rerank caps votes at 5 (+30% max)", () => {
  // ハブ h が 7 個の候補と繋がる → votes=7 だが cap 5 → graph:+5 (×1.30)。
  const nodes = [{ id: "h", type: "Decision", title: "認証" }];
  const edges = [];
  for (let i = 0; i < 7; i += 1) {
    nodes.push({ id: `s${i}`, type: "Decision", title: "認証" });
    edges.push({ id: `e${i}`, type: "refines", from: "h", to: `s${i}` });
  }
  const on = searchGraph({ nodes, edges }, "認証", { limit: 20, graphRerank: true });
  const hub = on.find((m) => m.node.id === "h");
  assert.ok(hub.reasons.includes("graph:+5"), "votes は 5 で頭打ち");
});

// --- R6 multi-query ---
test("searchGraph: queryVectors takes the max cosine across multiple query vectors", () => {
  const graph = {
    nodes: [
      { id: "n:x", type: "Decision", title: "x" }, // gist 側ベクトルに一致
      { id: "n:y", type: "Decision", title: "y" }  // 質問側ベクトルに一致
    ],
    edges: []
  };
  const vectorIndex = {
    rows: [
      { node_id: "n:x", vector: [0, 1] },
      { node_id: "n:y", vector: [1, 0] }
    ]
  };
  // 質問ベクトル [1,0] は y に、gist ベクトル [0,1] は x に一致。max を採れば両方拾える。
  const matches = searchGraph(graph, "zzz", {
    vectorIndex,
    queryVectors: [[1, 0], [0, 1]],
    limit: 10
  });
  const byId = new Map(matches.map((m) => [m.node.id, m]));
  assert.ok(byId.get("n:x").reasons.some((r) => r === "vector:1.00"), "x は gist ベクトルとの max=1");
  assert.ok(byId.get("n:y").reasons.some((r) => r === "vector:1.00"), "y は質問ベクトルとの max=1");
});

test("searchGraph: single queryVector still works (backward compatible)", () => {
  const graph = { nodes: [{ id: "n:1", type: "Decision", title: "認証" }], edges: [] };
  const vectorIndex = { rows: [{ node_id: "n:1", vector: [1, 0] }] };
  const matches = searchGraph(graph, "認証", { vectorIndex, queryVector: [1, 0], limit: 10 });
  assert.ok(matches[0].reasons.some((r) => /^vector:/.test(r)), "従来の単一 queryVector も効く");
});

import { loadGraph } from "./retrieval.ts";
import { buildVaultFiles } from "./build-vault.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("loadGraph reads from a vault directory (v3 single source)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rg-loadgraph-"));
  for (const f of buildVaultFiles({
    nodes: [{ id: "decision:sys:x", type: "Decision", title: "X" }], edges: []
  })) {
    const abs = path.join(dir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  try {
    const graph = await loadGraph(dir);
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.nodes[0].id, "decision:sys:x");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { beginVaultWrite, endVaultWrite } from "./vault-lock.ts";

// 版印 (seqlock) を読み手が尊重することの証明:
//   - 奇数 (書込中) の間は consistent read がタイムアウトして torn snapshot を返さない
//   - 偶数 (安定) なら loadGraph が通常どおりノードを返す
// stateDir は vault dir の隣 (.graphrag) という writer と同じ規約。
test("loadGraph honors the seqlock stamp (odd→consistent read times out, even→reads data)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rg-seqlock-"));
  const vaultDir = path.join(root, "vault");
  const stateDir = path.join(path.dirname(path.resolve(vaultDir)), ".graphrag");
  mkdirSync(vaultDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  for (const f of buildVaultFiles({
    nodes: [
      { id: "decision:sys:a", type: "Decision", title: "A" },
      { id: "decision:sys:b", type: "Decision", title: "B" }
    ],
    edges: [],
    generated_at: "2026-05-31T00:00:00.000Z"
  })) {
    const abs = path.join(vaultDir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  try {
    // 書込中に固定 (begin のみ、対応する end 無し → seq は奇数のまま)。
    const odd = beginVaultWrite(stateDir);
    // 奇数なら loadGraph 自身が短いタイムアウトで諦める (torn を返さない)。
    // 打刻を尊重していなければここで 2 ノードを返してしまい reject されない。
    await assert.rejects(
      () => loadGraph(vaultDir, { timeoutMs: 150, pollMs: 20 }),
      /readVaultConsistent timeout/
    );

    // 完了させる (seq を偶数へ): begin が返した奇数値 +1 = 偶数 = 完了。
    endVaultWrite(stateDir, odd);
    // 偶数なら loadGraph は通常どおりノードを返す。
    const graph = await loadGraph(vaultDir);
    assert.equal(graph.nodes.length, 2);
    const ids = graph.nodes.map((n) => n.id).sort();
    assert.deepEqual(ids, ["decision:sys:a", "decision:sys:b"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadGraph throws when no vault directory is given", async () => {
  const prev = process.env.GRAPHRAG_VAULT_DIR;
  delete process.env.GRAPHRAG_VAULT_DIR;
  try {
    await assert.rejects(() => loadGraph(undefined), /vault directory/);
  } finally {
    if (prev !== undefined) process.env.GRAPHRAG_VAULT_DIR = prev;
  }
});

import { defaultVectorIndexPath, loadRequiredVectorIndex, shouldRebuildVectorIndex } from "./retrieval.ts";
import { writeFile, mkdir, utimes } from "node:fs/promises";
import os from "node:os";
import fs from "node:fs";

test("defaultVectorIndexPath resolves next to the vault (in retrieval)", () => {
  // 索引は実 FS の絶対パスなので OS ネイティブ区切りが正しい。POSIX 直書きせず再導出して比較。
  const expected = path.join(path.dirname(path.resolve("/a/b/v")), ".graphrag", "vector.json");
  assert.equal(defaultVectorIndexPath("/a/b/v"), expected);
});

test("loadRequiredVectorIndex throws when the index file is absent (semantic required)", async () => {
  await assert.rejects(
    () => loadRequiredVectorIndex("/no/such/vault", undefined),
    /vector index not found/
  );
});

test("searchGraph does not match on node id (identifier excluded from search)", () => {
  const graph = { nodes: [{ id: "concern:acme:auth", type: "Concern", title: "認証基盤" }], edges: [] };
  // "concern" は id にしか無い (title は認証基盤)。id 除外なら一致しない。
  const m = searchGraph(graph, "concern", { limit: 10 });
  assert.equal(m.length, 0, "id token should not produce a match");
});

test("searchGraph demotes terminal-state nodes by 0.6 but never excludes them", () => {
  const graph = {
    nodes: [
      { id: "decision:s:now", type: "Decision", title: "認証基盤" },
      { id: "decision:s:old", type: "Decision", title: "認証基盤", state: "superseded" }
    ],
    edges: []
  };
  const matches = searchGraph(graph, "認証基盤", { limit: 10 });
  assert.equal(matches.length, 2, "終端 state でも除外しない (hard reject しない)");
  const byId = new Map(matches.map((m) => [m.node.id, m]));
  const now = byId.get("decision:s:now");
  const old = byId.get("decision:s:old");
  assert.ok(Math.abs(old.score - now.score * 0.6) < 0.01,
    `superseded は 0.6 倍 (now=${now.score}, old=${old.score})`);
  assert.equal(matches[0].node.id, "decision:s:now", "現役が上位");
  assert.ok(old.reasons.some((r) => r.startsWith("state:superseded")), "減点 reason を出す");
});

test("searchGraph attaches state_note to demoted matches only", () => {
  const graph = {
    nodes: [
      { id: "decision:s:old", type: "Decision", title: "認証", state: "superseded" },
      { id: "investigation:s:done", type: "Investigation", title: "認証", state: "closed" },
      { id: "goal:s:gone", type: "Goal", title: "認証", state: "abandoned" },
      { id: "goal:s:won", type: "Goal", title: "認証", state: "achieved" },
      { id: "investigation:s:live", type: "Investigation", title: "認証", state: "active" },
      { id: "decision:s:now", type: "Decision", title: "認証" }
    ],
    edges: []
  };
  const byId = new Map(searchGraph(graph, "認証", { limit: 10 }).map((m) => [m.node.id, m]));
  assert.match(byId.get("decision:s:old").state_note, /superseded — refines 逆引きで後継を確認/);
  assert.match(byId.get("investigation:s:done").state_note, /closed/);
  assert.match(byId.get("goal:s:gone").state_note, /abandoned/);
  assert.match(byId.get("goal:s:won").state_note, /achieved/);
  assert.ok(!("state_note" in byId.get("investigation:s:live")), "active には注記しない");
  assert.ok(!("state_note" in byId.get("decision:s:now")), "state 無しには注記しない");
});

test("searchGraph: active (non-terminal) state is not demoted", () => {
  const graph = {
    nodes: [
      { id: "investigation:s:live", type: "Investigation", title: "認証基盤", state: "active" },
      { id: "investigation:s:bare", type: "Investigation", title: "認証基盤" }
    ],
    edges: []
  };
  const matches = searchGraph(graph, "認証基盤", { limit: 10 });
  assert.equal(matches[0].score, matches[1].score, "active と state 無しは同点");
});

test("searchGraph does not match on node type name (type is a filter, not search text)", () => {
  const graph = { nodes: [{ id: "n1", type: "Concern", title: "認証基盤" }], edges: [] };
  // "Concern" は title に無く type のみ。文字一致の対象から type を外せば一致しない。
  const m = searchGraph(graph, "Concern", { limit: 10 });
  assert.equal(m.length, 0, "type name should not be a lexical match target");
  // type での絞り込みは types フィルタで引き続き可能
  const filtered = searchGraph(graph, "認証", { limit: 10, types: ["Concern"] });
  assert.equal(filtered.length, 1);
});

// --- shouldRebuildVectorIndex ---

test("shouldRebuildVectorIndex returns true when index file is absent", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "srvi-"));
  const vaultDir = path.join(tmp, "vault");
  await mkdir(path.join(vaultDir, "Decision"), { recursive: true });
  await writeFile(path.join(vaultDir, "Decision", "d1.md"), "---\nid: d1\n---\n");
  const indexPath = path.join(tmp, ".graphrag", "vector.json");
  assert.equal(await shouldRebuildVectorIndex(vaultDir, indexPath), true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("shouldRebuildVectorIndex returns false when index is newer than all vault files", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "srvi-"));
  const vaultDir = path.join(tmp, "vault");
  await mkdir(path.join(vaultDir, "Decision"), { recursive: true });
  await writeFile(path.join(vaultDir, "Decision", "d1.md"), "---\nid: d1\n---\n");
  const graphragDir = path.join(tmp, ".graphrag");
  await mkdir(graphragDir, { recursive: true });
  const indexPath = path.join(graphragDir, "vector.json");
  // vault ファイルを過去に設定し、索引を現在時刻で作成
  const past = new Date(Date.now() - 60_000);
  await utimes(path.join(vaultDir, "Decision", "d1.md"), past, past);
  await writeFile(indexPath, "{}");
  assert.equal(await shouldRebuildVectorIndex(vaultDir, indexPath), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("shouldRebuildVectorIndex returns true when a vault file is newer than index", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "srvi-"));
  const vaultDir = path.join(tmp, "vault");
  await mkdir(path.join(vaultDir, "Decision"), { recursive: true });
  const graphragDir = path.join(tmp, ".graphrag");
  await mkdir(graphragDir, { recursive: true });
  const indexPath = path.join(graphragDir, "vector.json");
  // 索引を過去に設定し、vault ファイルを現在時刻で作成
  await writeFile(indexPath, "{}");
  const past = new Date(Date.now() - 60_000);
  await utimes(indexPath, past, past);
  await writeFile(path.join(vaultDir, "Decision", "d1.md"), "---\nid: d1\n---\n");
  assert.equal(await shouldRebuildVectorIndex(vaultDir, indexPath), true);
  fs.rmSync(tmp, { recursive: true, force: true });
});
