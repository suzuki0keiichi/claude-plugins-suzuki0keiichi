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
// seq の置き場所は vault dir の隣 .graphrag の cache/ (E1) という writer と同じ規約。
test("loadGraph honors the seqlock stamp (odd→consistent read times out, even→reads data)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rg-seqlock-"));
  const vaultDir = path.join(root, "vault");
  const stateDir = path.join(path.dirname(path.resolve(vaultDir)), ".graphrag", "cache");
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

test("defaultVectorIndexPath resolves to the vault's .graphrag/cache (in retrieval)", () => {
  // 索引は実 FS の絶対パスなので OS ネイティブ区切りが正しい。POSIX 直書きせず再導出して比較。
  const expected = path.join(path.dirname(path.resolve("/a/b/v")), ".graphrag", "cache", "vector.json");
  assert.equal(defaultVectorIndexPath("/a/b/v"), expected);
});

// graphrag:enforces constraint:graphrag-skill-dev:semantic-non-negotiable — semantic 検索は非交渉、
// lexical 単独フォールバックは設計しない (索引が無ければ ask は明示エラーで止まる)
test("loadRequiredVectorIndex throws when the index file is absent (semantic required)", async () => {
  await assert.rejects(
    () => loadRequiredVectorIndex("/no/such/vault", undefined),
    /vector index not found/
  );
});

// ── E1: legacy (.graphrag 直下) からの読み取り fallback ──

test("loadRequiredVectorIndex: cache/ に索引が無ければ legacy (.graphrag 直下) を読む", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vec-legacy-"));
  try {
    const vaultDir = path.join(tmp, "vault");
    await mkdir(path.join(vaultDir, "Decision"), { recursive: true });
    await writeFile(path.join(vaultDir, "Decision", "d1.md"), "---\nid: d1\n---\n");
    // vault ファイルを過去に (索引の方が新しい = 再構築不要 = endpoint 非依存)
    const past = new Date(Date.now() - 60_000);
    await utimes(path.join(vaultDir, "Decision", "d1.md"), past, past);
    // legacy 位置 (.graphrag/vector.json) にだけ索引がある (移行前の状態)
    const graphragDir = path.join(tmp, ".graphrag");
    await mkdir(graphragDir, { recursive: true });
    await writeFile(
      path.join(graphragDir, "vector.json"),
      JSON.stringify({ version: 1, provider: "legacy-marker", semantic: false, rows: [] })
    );
    const idx = await loadRequiredVectorIndex(vaultDir);
    assert.equal(idx.provider, "legacy-marker", "legacy 索引が読まれる");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── E3: readonly mode では消費側 cache の索引を読む (外部 vault 側に書かない) ──

import { consumerCacheDirForVault } from "./cli-env.ts";
import { execFileSync } from "node:child_process";

test("loadRequiredVectorIndex: readonly では消費側 cache/external/<hash> の索引を使う", async () => {
  const consumer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vec-ro-consumer-")));
  const ext = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vec-ro-ext-")));
  const prevCwd = process.cwd();
  try {
    // 外部 vault (索引は持っていない = git pull したての想定)
    const vaultDir = path.join(ext, "vault");
    await mkdir(path.join(vaultDir, "Decision"), { recursive: true });
    await writeFile(path.join(vaultDir, "Decision", "d1.md"), "---\nid: d1\n---\n");
    const past = new Date(Date.now() - 60_000);
    await utimes(path.join(vaultDir, "Decision", "d1.md"), past, past);
    // 消費側: readonly のローカル mode + 消費側 cache に構築済み索引
    await mkdir(path.join(consumer, ".graphrag"), { recursive: true });
    await writeFile(path.join(consumer, ".graphrag", ".env"), "GRAPHRAG_VAULT_MODE=readonly\n");
    const consumerDir = consumerCacheDirForVault(vaultDir, consumer)!;
    await mkdir(consumerDir, { recursive: true });
    await writeFile(
      path.join(consumerDir, "vector.json"),
      JSON.stringify({ version: 1, provider: "consumer-marker", semantic: false, rows: [] })
    );
    process.chdir(consumer);
    const idx = await loadRequiredVectorIndex(vaultDir);
    assert.equal(idx.provider, "consumer-marker", "消費側 cache の索引が読まれる");
    // 外部 vault の隣には何も生成されない (readonly の本義)
    assert.ok(!fs.existsSync(path.join(ext, ".graphrag")), "外部側に .graphrag を作らない");
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(consumer, { recursive: true, force: true });
    fs.rmSync(ext, { recursive: true, force: true });
  }
});

// #3 回帰: 親 repo で readonly を宣言していても、実行してる worktree サブディレクトリに
// ローカルの .graphrag/.env が無ければ mode_source は "inherited" になり、
// needsLocalDecision で demote されて (旧コードの参照先だった) mode は null になる。
// raw_mode (demote 前) でルーティングすることで、それでも消費側 cache へ書く。
test("loadRequiredVectorIndex: 外部 vault + inherited readonly (worktree) でも消費側 cache を使う", async () => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vec-ro-parent-")));
  const ext = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vec-ro-ext2-")));
  const prevCwd = process.cwd();
  const originalMode = process.env.GRAPHRAG_VAULT_MODE;
  try {
    execFileSync("git", ["init", "-q"], { cwd: parent });
    execFileSync("git", ["init", "-q"], { cwd: ext });
    const vaultDir = path.join(ext, "vault");
    await mkdir(path.join(vaultDir, "Decision"), { recursive: true });
    await writeFile(path.join(vaultDir, "Decision", "d1.md"), "---\nid: d1\n---\n");
    const past = new Date(Date.now() - 60_000);
    await utimes(path.join(vaultDir, "Decision", "d1.md"), past, past);

    // 親 repo の .graphrag/.env で readonly を宣言 (今回のテストでは discoverAndLoadGraphragEnv の
    // 継承結果を process.env に直接反映して模す)。実行される worktree サブディレクトリ自体には
    // ローカルの .graphrag/.env は無い。
    await mkdir(path.join(parent, ".graphrag"), { recursive: true });
    const worktreeSub = path.join(parent, "sub", "dir");
    await mkdir(worktreeSub, { recursive: true });
    process.env.GRAPHRAG_VAULT_MODE = "readonly";

    const consumerDir = consumerCacheDirForVault(vaultDir, worktreeSub)!;
    await mkdir(consumerDir, { recursive: true });
    await writeFile(
      path.join(consumerDir, "vector.json"),
      JSON.stringify({ version: 1, provider: "inherited-consumer-marker", semantic: false, rows: [] })
    );

    process.chdir(worktreeSub);
    const idx = await loadRequiredVectorIndex(vaultDir);
    assert.equal(idx.provider, "inherited-consumer-marker", "inherited readonly でも消費側 cache が使われる");
    assert.ok(!fs.existsSync(path.join(ext, ".graphrag")), "外部側に .graphrag を作らない");
  } finally {
    process.chdir(prevCwd);
    if (originalMode === undefined) delete process.env.GRAPHRAG_VAULT_MODE;
    else process.env.GRAPHRAG_VAULT_MODE = originalMode;
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(ext, { recursive: true, force: true });
  }
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
  assert.match(byId.get("decision:s:old").state_note, /superseded — check refines reverse for successor/);
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

// --- lexical scoring fixes (per-token ngram / weighted coverage / script partition) ---

test("makeNgrams (via searchGraph): Latin bigrams no longer match unrelated English", () => {
  // 旧実装は空白除去した連結文字列に 2-gram を作り、"chocolate cake" が日本語 vault の
  // 英字断片に ngram 0.58 を出していた。トークン毎 3-gram 化で偶然一致が消えることを確認。
  const graph = {
    nodes: [{ id: "d:1", type: "Decision", title: "vault path policy", summary: "cache layout decision" }],
    edges: []
  };
  const matches = searchGraph(graph, "chocolate cake recipe", { limit: 10 });
  const ngram = matches[0]?.reasons.find((r) => r.startsWith("ngram:"));
  const ratio = ngram ? Number(ngram.slice("ngram:".length)) : 0;
  assert.ok(ratio < 0.2, `無関係な英語クエリの ngram は ~0 であるべき (got ${ngram ?? "none"})`);
});

test("searchGraph: term coverage is char-weighted and emitted as coverage:<n>", () => {
  const graph = {
    nodes: [
      // 短い機能語しか当たらないノード vs 長い内容語が当たるノード
      { id: "d:short", type: "Decision", title: "それは何か" },
      { id: "d:content", type: "Decision", title: "認証基盤アーキテクチャ" }
    ],
    edges: []
  };
  // クエリ: 内容語 "認証基盤アーキテクチャ" (11字) + latin "x" (1字)
  const matches = searchGraph(graph, "認証基盤アーキテクチャ x", { limit: 10 });
  const content = matches.find((m) => m.node.id === "d:content");
  assert.ok(content, "内容語ノードはヒットする");
  const coverage = content.reasons.find((r) => r.startsWith("coverage:"));
  assert.ok(coverage, "coverage:<n> reason を出す (confidence.ts が拾う)");
  assert.ok(Number(coverage.slice("coverage:".length)) >= 0.9,
    `文字数重み付きで 11/12 ≈ 0.92 相当 (got ${coverage})`);
});

test("searchGraph: ≤2-char hiragana function words are dropped from coverage", () => {
  const graph = {
    nodes: [
      { id: "d:stop", type: "Decision", title: "なぜ した のか" },       // 機能語のみ一致
      { id: "d:real", type: "Decision", title: "vault 単一正本" }        // 内容語一致
    ],
    edges: []
  };
  const matches = searchGraph(graph, "なぜ vault を 単一正本 に した", { limit: 10 });
  const byId = new Map(matches.map((m) => [m.node.id, m]));
  const stop = byId.get("d:stop");
  const real = byId.get("d:real");
  assert.ok(real, "内容語ノードはヒット");
  const stopCoverage = stop?.reasons.find((r) => r.startsWith("coverage:"));
  assert.ok(!stopCoverage || Number(stopCoverage.slice(9)) === 0,
    "機能語だけの一致は coverage を得ない");
  assert.ok(real.score > (stop?.score ?? 0), "内容語一致が機能語一致より上位");
});

test("searchGraph: dual-language (JA+EN) query takes per-script max coverage", () => {
  const graph = {
    nodes: [
      { id: "d:ja", type: "Decision", title: "重複チェックの仕組み" },   // 日本語のみのノード
      { id: "d:en", type: "Decision", title: "duplicate check mechanism" } // 英語のみのノード
    ],
    edges: []
  };
  // JA+EN 併記クエリ (SKILL.md 推奨形)。単言語ノードが半分を取りこぼしても
  // スクリプト別 max で救済される (双方 coverage ~1.0 相当)。
  const matches = searchGraph(graph, "重複チェック duplicate check", { limit: 10 });
  const byId = new Map(matches.map((m) => [m.node.id, m]));
  for (const id of ["d:ja", "d:en"]) {
    const m = byId.get(id);
    assert.ok(m, `${id} はヒットする`);
    const coverage = m.reasons.find((r) => r.startsWith("coverage:"));
    assert.ok(coverage && Number(coverage.slice(9)) >= 0.9,
      `${id} の coverage はスクリプト別 max で ~1.0 (got ${coverage})`);
  }
});

test("searchGraph: a tiny Latin token cannot claim per-script coverage 1.0", () => {
  // 日本語主体クエリの中の短い英単語 1 個 (全体の 1/3 未満) は「クエリの言い換え」
  // ではないので、それだけ当たっても coverage 1.0 を僭称しない。
  const graph = {
    nodes: [{ id: "d:1", type: "Decision", title: "vault の話" }],
    edges: []
  };
  const matches = searchGraph(graph, "全然関係ない長い日本語の質問文で vault", { limit: 10 });
  const coverage = matches[0]?.reasons.find((r) => r.startsWith("coverage:"));
  assert.ok(!coverage || Number(coverage.slice(9)) < 0.5,
    `latin 部分単独の coverage 1.0 は禁止 (got ${coverage})`);
});

// --- type boost (Decision/Constraint/OperationalKnowledge ×1.05) ---

test("searchGraph: distilled-knowledge types get a small multiplier that can reorder near-ties", () => {
  const graph = {
    nodes: [
      { id: "c:chunk", type: "ConversationChunk", title: "認証" },
      { id: "d:dec", type: "Decision", title: "認証" },
      { id: "k:ok", type: "OperationalKnowledge", title: "認証" },
      { id: "s:con", type: "Constraint", title: "認証" }
    ],
    edges: []
  };
  const matches = searchGraph(graph, "認証", { limit: 10 });
  const byId = new Map(matches.map((m) => [m.node.id, m]));
  const chunk = byId.get("c:chunk");
  for (const id of ["d:dec", "k:ok", "s:con"]) {
    const boosted = byId.get(id);
    assert.ok(Math.abs(boosted.score - chunk.score * 1.05) < 0.01,
      `${id} は ×1.05 (chunk=${chunk.score}, got ${boosted.score})`);
    assert.ok(boosted.reasons.some((r) => r.startsWith("type:")), "type boost reason を出す");
  }
  assert.equal(matches[matches.length - 1].node.id, "c:chunk", "同点なら蒸留ノードが上");
});

// --- expandNeighbors caps + priority ---

import { expandNeighbors, edgePriority } from "./retrieval.ts";

test("expandNeighbors: does not emit duplicate edges at depth 2", () => {
  const graph = {
    nodes: [
      { id: "a", type: "Decision", title: "a" },
      { id: "b", type: "Decision", title: "b" }
    ],
    edges: [{ id: "e1", type: "refines", from: "a", to: "b" }]
  };
  const expansions = expandNeighbors(graph, ["a"], 2);
  assert.equal(expansions.length, 1, "同じ edge を深さ 2 で再掲しない");
});

test("expandNeighbors: caps per-node edges by priority (backbone edges first)", () => {
  const nodes = [{ id: "hub", type: "File", title: "hub" }];
  const edges = [];
  // 出所系 12 本 + 背骨系 2 本 (グラフ上は後ろに置く → 優先度で先頭に来ることを確認)
  for (let i = 0; i < 12; i += 1) {
    nodes.push({ id: `d${i}`, type: "File", title: `d${i}` });
    edges.push({ id: `ed${i}`, type: "documented_by", from: "hub", to: `d${i}` });
  }
  nodes.push({ id: "succ", type: "Decision", title: "succ" });
  nodes.push({ id: "pol", type: "Decision", title: "pol" });
  edges.push({ id: "es", type: "supersedes", from: "succ", to: "hub" });
  edges.push({ id: "ep", type: "sets_policy_for", from: "pol", to: "hub" });
  const expansions = expandNeighbors({ nodes, edges }, ["hub"], 1);
  assert.equal(expansions.length, 10, "per-node cap は 10");
  const types = expansions.map((e) => e.edge.type);
  assert.equal(types[0], "supersedes", "supersedes が最優先");
  assert.equal(types[1], "sets_policy_for");
  assert.ok(types.slice(2).every((t) => t === "documented_by"), "残りは出所系で埋まる");
});

test("expandNeighbors: global cap stops the flood", () => {
  const nodes = [];
  const edges = [];
  for (let s = 0; s < 5; s += 1) {
    nodes.push({ id: `seed${s}`, type: "Decision", title: `s${s}` });
    for (let i = 0; i < 10; i += 1) {
      nodes.push({ id: `n${s}-${i}`, type: "Decision", title: `n` });
      edges.push({ id: `e${s}-${i}`, type: "refines", from: `seed${s}`, to: `n${s}-${i}` });
    }
  }
  const expansions = expandNeighbors({ nodes, edges }, nodes.filter((n) => n.id.startsWith("seed")).map((n) => n.id), 1);
  assert.equal(expansions.length, 40, "global cap は 40");
});

test("edgePriority: backbone < default < provenance", () => {
  assert.ok(edgePriority("supersedes") < edgePriority("led_to"));
  assert.ok(edgePriority("led_to") < edgePriority("documented_by"));
  assert.ok(edgePriority("refines") < edgePriority("discussed_in"));
});
