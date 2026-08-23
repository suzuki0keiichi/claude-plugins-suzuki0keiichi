import assert from "node:assert/strict";
import test from "node:test";
import { embedNodes, embedNodesIncremental, vectorTextHash, buildVectorIndex, parseArgs, writeFileAtomic, main } from "./build-vector-index.ts";
import { defaultVectorIndexPath } from "./retrieval.ts";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildVaultFiles } from "./build-vault.ts";
import { nodeVectorText } from "./vector.ts";

function writeVault(graph): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vec-vault-"));
  for (const f of buildVaultFiles(graph)) {
    const abs = path.join(dir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  return dir;
}

// 外部 endpoint を呼ばない deterministic fake provider。
function fakeProvider(dim = 3) {
  return {
    id: "fake", capability: "semantic", semantic: true, dimensions: dim,
    metadata: { endpoint: "http://fake/v1/embeddings", model: "fake-model" },
    embed: async (text: string) => {
      const v = new Array(dim).fill(0);
      v[0] = text.length % 5;
      v[1] = 1;
      return v;
    }
  };
}

test("embedNodes embeds each node and records id/dimensions/vector", async () => {
  const nodes = [
    { id: "decision:sys:a", type: "Decision", title: "A" },
    { id: "goal:sys:p99", type: "Goal", title: "p99" }
  ];
  const rows = await embedNodes(nodes, fakeProvider(3));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].node_id, "decision:sys:a");
  assert.equal(rows[0].dimensions, 3);
  assert.equal(rows[0].vector.length, 3);
  assert.equal(rows[1].node_id, "goal:sys:p99");
});

test("buildVectorIndex accepts an injected provider (no external endpoint)", async () => {
  const provider = fakeProvider(4);
  const graph = { version: 7, nodes: [{ id: "n1", type: "Decision", title: "T" }], edges: [] };
  const payload = await buildVectorIndex({}, { provider, graphObject: graph });
  assert.equal(payload.provider, "fake");
  assert.equal(payload.semantic, true);
  assert.equal(payload.dimensions, 4);
  assert.equal(payload.graph_version, 7);
  assert.equal(payload.rows.length, 1);
  assert.equal(payload.rows[0].node_id, "n1");
});

test("buildVectorIndex builds from a vault directory (importVault path)", async () => {
  const graph = {
    generated_at: "2026-05-29T00:00:00.000Z",
    nodes: [
      { id: "system:acme", type: "System", title: "Acme" },
      { id: "goal:acme:p99", type: "Goal", title: "p99", summary: "性能" },
      { id: "concern:acme:auth", type: "Concern", title: "認証" }
    ],
    edges: [{ id: "e1", type: "contains", from: "system:acme", to: "goal:acme:p99" }]
  };
  const dir = writeVault(graph);
  try {
    const payload = await buildVectorIndex({ vault: dir }, { provider: fakeProvider(3) });
    const ids = new Set(payload.rows.map((r) => r.node_id));
    assert.equal(payload.rows.length, 3, "every vault node embedded");
    assert.ok(ids.has("goal:acme:p99"));
    assert.ok(ids.has("concern:acme:auth"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nodeVectorText captures v3-type nodes (Goal/Concern/Layer/Component)", () => {
  const goal = nodeVectorText({ id: "goal:acme:p99", type: "Goal", title: "p99 < 200ms", summary: "性能ゴール" });
  assert.ok(goal.includes("Goal"));
  assert.ok(goal.includes("p99 < 200ms"));
  assert.ok(goal.includes("性能ゴール"));
  for (const t of ["Layer", "Concern", "Component"]) {
    const txt = nodeVectorText({ id: `x:${t}`, type: t, title: `T-${t}` });
    assert.ok(txt.includes(t), `nodeVectorText must include type ${t}`);
    assert.ok(txt.includes(`T-${t}`));
  }
});

test("parseArgs reads --vault and GRAPHRAG_VAULT_DIR", () => {
  assert.equal(parseArgs(["--vault", "/tmp/v", "--out", "/tmp/o"]).vault, "/tmp/v");
  const prev = process.env.GRAPHRAG_VAULT_DIR;
  process.env.GRAPHRAG_VAULT_DIR = "/env/vault";
  try {
    assert.equal(parseArgs(["--out", "/tmp/o"]).vault, "/env/vault");
  } finally {
    if (prev === undefined) delete process.env.GRAPHRAG_VAULT_DIR;
    else process.env.GRAPHRAG_VAULT_DIR = prev;
  }
});

// (旧テスト「vault + base together を reject」は撤去: --base / base-delta ビルド自体を
// issue #30 で丸ごと削除したため、ガード対象の引数が存在しない。)

test("buildVectorIndex prefers vault over graph when both are given", async () => {
  const dir = writeVault({
    nodes: [{ id: "concern:acme:auth", type: "Concern", title: "認証" }],
    edges: []
  });
  try {
    // graph は存在しないパスだが vault 優先なので loadGraph は呼ばれず成功するはず
    const payload = await buildVectorIndex({ vault: dir, graph: "/nonexistent.json" }, { provider: fakeProvider(3) });
    assert.equal(payload.rows.length, 1);
    assert.equal(payload.rows[0].node_id, "concern:acme:auth");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildVectorIndex on an empty vault yields zero rows without crashing", async () => {
  const dir = writeVault({ nodes: [], edges: [] });
  try {
    const payload = await buildVectorIndex({ vault: dir }, { provider: fakeProvider(3) });
    assert.equal(payload.rows.length, 0);
    // 空でも payload は構築でき、dimensions は provider 申告にフォールバック
    assert.equal(payload.dimensions, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultVectorIndexPath places the index in the vault's .graphrag/cache (E1)", () => {
  // 索引は実 FS の絶対パスなので OS ネイティブ区切りが正しい。POSIX 直書きせず再導出して比較。
  const expected = path.join(path.dirname(path.resolve("/a/b/myvault")), ".graphrag", "cache", "vector.json");
  assert.equal(defaultVectorIndexPath("/a/b/myvault"), expected);
  // 末尾スラッシュも正規化される
  assert.equal(defaultVectorIndexPath("/a/b/myvault/"), expected);
});

test("parseArgs defaults --out to the vault-adjacent index path when only --vault is given", () => {
  const args = parseArgs(["--vault", "/a/b/myvault"]);
  assert.equal(args.vault, "/a/b/myvault");
  assert.equal(args.out, path.join(path.dirname(path.resolve("/a/b/myvault")), ".graphrag", "cache", "vector.json"));
  // 明示 --out があればそちらが優先
  const explicit = parseArgs(["--vault", "/a/b/myvault", "--out", "/custom/v.json"]);
  assert.equal(explicit.out, "/custom/v.json");
});

test("writeFileAtomic writes via a temp file then rename, leaving no temp behind", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vec-atomic-"));
  const out = path.join(dir, "sub", "vector.json");
  try {
    await writeFileAtomic(out, '{"ok":1}\n');
    assert.equal(readFileSync(out, "utf8"), '{"ok":1}\n');
    // 一時ファイルが残っていない (最終ファイルのみ)
    const left = readdirSync(path.dirname(out));
    assert.deepEqual(left, ["vector.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main builds the index and writes it next to the vault (atomic), injected provider", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vec-main-"));
  const vaultDir = path.join(root, "myvault");
  for (const f of buildVaultFiles({
    generated_at: "2026-05-29T00:00:00.000Z",
    nodes: [
      { id: "system:acme", type: "System", title: "Acme" },
      { id: "concern:acme:auth", type: "Concern", title: "認証" }
    ],
    edges: [{ id: "e1", type: "contains", from: "system:acme", to: "concern:acme:auth" }]
  })) {
    const abs = path.join(vaultDir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  try {
    await main(["--vault", vaultDir], { provider: fakeProvider(3) });
    const expected = path.join(root, ".graphrag", "cache", "vector.json");
    assert.ok(existsSync(expected), "index written next to the vault (cache/)");
    const payload = JSON.parse(readFileSync(expected, "utf8"));
    assert.ok(payload.rows.length >= 1, "rows embedded");
    assert.equal(payload.provider, "fake");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildVectorIndex requires a vault (no falkor/json fallback)", async () => {
  await assert.rejects(
    () => buildVectorIndex({ graph: "/some/graph.json" }, { provider: fakeProvider(3) }),
    /vault/
  );
});

test("nodeVectorText excludes node id (keeps embedding stable across id canonicalization)", () => {
  const txt = nodeVectorText({ id: "concern:acme:auth", type: "Concern", title: "認証", summary: "横断" });
  assert.ok(!txt.includes("concern:acme:auth"), "id must be excluded from embedding text");
  assert.ok(txt.includes("Concern"), "type kept");
  assert.ok(txt.includes("認証"), "title kept");
});

// embed 呼び出し回数を数える deterministic fake provider (ネットワーク不要)。
function countingProvider(dim = 3) {
  const p: any = {
    id: "fake", capability: "semantic", semantic: true, dimensions: dim,
    metadata: { endpoint: "http://fake/v1/embeddings", model: "fake-model" },
    calls: 0
  };
  p.embed = async (text: string) => {
    p.calls += 1;
    const v = new Array(dim).fill(0);
    v[0] = text.length % 5;
    v[1] = 1;
    return v;
  };
  return p;
}

// --- R1 接頭辞ポリシー (build 側 round-trip) ---
// 各 embed 呼び出しに渡された text を記録する fake provider。model 名で接頭辞ポリシーが
// 効くかどうかが変わるので model を引数化する。
function recordingProvider(dim = 3, model = "nomic-embed-text") {
  const p: any = {
    id: "openai-compatible-embedding", capability: "semantic", semantic: true, dimensions: dim,
    metadata: { endpoint: "http://fake/v1/embeddings", model },
    seen: [] as string[]
  };
  p.embed = async (text: string) => {
    p.seen.push(text);
    const v = new Array(dim).fill(0);
    v[0] = text.length % 5;
    v[1] = 1;
    return v;
  };
  return p;
}

test("buildVectorIndex (auto): registered model prefixes document text and records prefix_policy", async () => {
  const provider = recordingProvider(3, "nomic-embed-text");
  const graph = { version: 1, nodes: [{ id: "n1", type: "Decision", title: "認証基盤" }], edges: [] };
  const payload = await buildVectorIndex({ prefixPolicy: "auto" }, { provider, graphObject: graph });
  assert.deepEqual(payload.prefix_policy, { document: "search_document: ", query: "search_query: " },
    "適用したポリシーをメタに記録");
  assert.ok(provider.seen[0].startsWith("search_document: "), "embedding 入力に document 接頭辞");
});

test("buildVectorIndex (off): no prefix applied and no prefix_policy meta", async () => {
  const provider = recordingProvider(3, "nomic-embed-text");
  const graph = { version: 1, nodes: [{ id: "n1", type: "Decision", title: "認証基盤" }], edges: [] };
  const payload = await buildVectorIndex({ prefixPolicy: "off" }, { provider, graphObject: graph });
  assert.equal(payload.prefix_policy, undefined, "off ではメタを記録しない (旧 index 互換)");
  assert.ok(!provider.seen[0].startsWith("search_document: "), "off では接頭辞を付けない");
});

test("buildVectorIndex (auto): unregistered model gets no prefix and no meta", async () => {
  const provider = recordingProvider(3, "text-embedding-3-small");
  const graph = { version: 1, nodes: [{ id: "n1", type: "Decision", title: "認証基盤" }], edges: [] };
  const payload = await buildVectorIndex({ prefixPolicy: "auto" }, { provider, graphObject: graph });
  assert.equal(payload.prefix_policy, undefined, "未登録モデルは接頭辞ポリシーなし");
  assert.ok(!provider.seen[0].startsWith("search_document: "));
});

test("buildVectorIndex: prefix policy change invalidates cached vectors (re-embed)", async () => {
  const g = { version: 1, nodes: [{ id: "n1", type: "Decision", title: "認証基盤" }], edges: [] };
  // 先に off で構築 (接頭辞なし)
  const off = recordingProvider(3, "nomic-embed-text");
  const p1 = await buildVectorIndex({ prefixPolicy: "off" }, { provider: off, graphObject: g });
  // auto で再構築: ポリシーが変わる (接頭辞付与) → 前回ベクトルは別空間なので再 embed
  const auto = recordingProvider(3, "nomic-embed-text");
  await buildVectorIndex({ prefixPolicy: "auto" }, { provider: auto, graphObject: g, previousIndex: p1 });
  assert.equal(auto.seen.length, 1, "ポリシー変更で unchanged ノードも再 embedding");
  assert.ok(auto.seen[0].startsWith("search_document: "));
});

test("parseArgs reads --prefix-policy (auto default, off override)", () => {
  assert.equal(parseArgs(["--vault", "/v"]).prefixPolicy, "auto");
  assert.equal(parseArgs(["--vault", "/v", "--prefix-policy", "off"]).prefixPolicy, "off");
  assert.equal(parseArgs(["--vault", "/v", "--prefix-policy", "auto"]).prefixPolicy, "auto");
});

test("vectorTextHash is stable for same text and differs when embedding text changes", () => {
  const a = { id: "decision:s:a", type: "Decision", title: "A", summary: "alpha" };
  const aSame = { id: "decision:s:a-renamed-id", type: "Decision", title: "A", summary: "alpha" };
  const aChanged = { id: "decision:s:a", type: "Decision", title: "A", summary: "ALPHA-changed" };
  assert.equal(vectorTextHash(a), vectorTextHash(aSame), "id is excluded → same embedding text → same hash");
  assert.notEqual(vectorTextHash(a), vectorTextHash(aChanged), "changed summary → different hash");
});

test("embedNodesIncremental reuses unchanged vectors and only embeds new/changed nodes", async () => {
  const provider = countingProvider(3);
  const a = { id: "decision:s:a", type: "Decision", title: "A", summary: "alpha" };
  const b = { id: "decision:s:b", type: "Decision", title: "B", summary: "beta" };

  const first = await embedNodesIncremental([a, b], provider, []);
  assert.equal(provider.calls, 2, "cold build embeds all nodes");
  assert.ok(first.every((r) => typeof r.text_hash === "string" && r.text_hash.length > 0), "rows carry text_hash");

  const bChanged = { ...b, summary: "BETA-changed" };
  const c = { id: "decision:s:c", type: "Decision", title: "C", summary: "gamma" };
  provider.calls = 0;
  const second = await embedNodesIncremental([a, bChanged, c], provider, first);
  assert.equal(provider.calls, 2, "only changed(b) + new(c) re-embedded; unchanged(a) reused");
  assert.equal(second.length, 3);
  const aNow = second.find((r) => r.node_id === "decision:s:a");
  const aWas = first.find((r) => r.node_id === "decision:s:a");
  assert.deepEqual(aNow.vector, aWas.vector, "unchanged node vector reused verbatim");
});

test("buildVectorIndex reuses cached vectors via deps.previousIndex (incremental rebuild)", async () => {
  const provider = countingProvider(3);
  const g1 = {
    version: 1,
    nodes: [
      { id: "n1", type: "Decision", title: "T1", summary: "s1" },
      { id: "n2", type: "Decision", title: "T2", summary: "s2" }
    ],
    edges: []
  };
  const p1 = await buildVectorIndex({}, { provider, graphObject: g1 });
  assert.equal(provider.calls, 2, "first build embeds both");

  // n1 unchanged, n2 changed, n3 added
  const g2 = {
    version: 2,
    nodes: [
      { id: "n1", type: "Decision", title: "T1", summary: "s1" },
      { id: "n2", type: "Decision", title: "T2", summary: "s2-CHANGED" },
      { id: "n3", type: "Decision", title: "T3", summary: "s3" }
    ],
    edges: []
  };
  provider.calls = 0;
  const p2 = await buildVectorIndex({}, { provider, graphObject: g2, previousIndex: p1 });
  assert.equal(provider.calls, 2, "only n2(changed)+n3(new) embedded, n1 reused");
  assert.equal(p2.rows.length, 3);
  const n1now = p2.rows.find((r) => r.node_id === "n1").vector;
  const n1was = p1.rows.find((r) => r.node_id === "n1").vector;
  assert.deepEqual(n1now, n1was, "unchanged n1 vector reused");
});

test("buildVectorIndex ignores cache when previous index model differs (full re-embed)", async () => {
  const g = { version: 1, nodes: [{ id: "n1", type: "Decision", title: "T1", summary: "s1" }], edges: [] };
  const provider = countingProvider(3);
  const p1 = await buildVectorIndex({}, { provider, graphObject: g });
  // 別モデルで作られた索引は再利用してはいけない (埋め込み空間が違う)
  const stalePrev = { ...p1, provider_options: { ...(p1.provider_options ?? {}), model: "old-model" } };
  const fresh = countingProvider(3); // model "fake-model"
  const p2 = await buildVectorIndex({}, { provider: fresh, graphObject: g, previousIndex: stalePrev });
  assert.equal(fresh.calls, 1, "model mismatch → re-embed even unchanged node");
});

test("buildVectorIndex re-embeds legacy rows lacking text_hash (v1 index backward compat)", async () => {
  const provider = countingProvider(3);
  const g = { version: 1, nodes: [{ id: "n1", type: "Decision", title: "T1", summary: "s1" }], edges: [] };
  const legacyPrev = {
    provider: "fake", semantic: true, dimensions: 3, provider_options: { model: "fake-model" },
    rows: [{ node_id: "n1", dimensions: 3, vector: [9, 9, 9] }] // no text_hash
  };
  const p = await buildVectorIndex({}, { provider, graphObject: g, previousIndex: legacyPrev });
  assert.equal(provider.calls, 1, "legacy row without text_hash is re-embedded");
  assert.notDeepEqual(p.rows[0].vector, [9, 9, 9], "stale legacy vector not reused");
});

// ── vault_head 打刻 (索引 staleness の可視化基盤) ─────────────────────────────

import { execFileSync } from "node:child_process";

test("buildVectorIndex stamps vault_head when the vault is a git repo", async () => {
  const graph = {
    generated_at: "2026-05-29T00:00:00.000Z",
    nodes: [{ id: "goal:acme:p99", type: "Goal", title: "p99", summary: "perf" }],
    edges: []
  };
  const dir = writeVault(graph);
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
    execFileSync("git", ["-C", dir, "add", "."]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "seed"]);
    const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const payload = await buildVectorIndex({ vault: dir }, { provider: fakeProvider(3) });
    assert.equal(payload.vault_head, head, "索引がどの vault HEAD から構築されたかを打刻する");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildVectorIndex omits vault_head when the vault is not a git repo (best-effort)", async () => {
  const graph = {
    generated_at: "2026-05-29T00:00:00.000Z",
    nodes: [{ id: "goal:acme:p99", type: "Goal", title: "p99", summary: "perf" }],
    edges: []
  };
  const dir = writeVault(graph);
  try {
    const payload = await buildVectorIndex({ vault: dir }, { provider: fakeProvider(3) });
    assert.equal(payload.vault_head, undefined, "git 外では打刻しない (エラーにもしない)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- noise baseline (コーパス相対 confidence の基準値) ---

import { computeNoiseBaseline } from "./build-vector-index.ts";

test("computeNoiseBaseline: deterministic median/p90 from row vectors", () => {
  const rows = [];
  for (let i = 0; i < 20; i += 1) {
    // 単位ベクトルを角度でばらす (正規化済み前提と同じ形)
    const t = (i / 20) * Math.PI;
    rows.push({ node_id: `n${String(i).padStart(2, "0")}`, vector: [Math.cos(t), Math.sin(t)] });
  }
  const a = computeNoiseBaseline(rows);
  const b = computeNoiseBaseline([...rows].reverse()); // 入力順に依存しない (node_id でソート)
  assert.ok(a && b);
  assert.deepEqual(a, b, "seeded PRNG + id ソートで決定論");
  assert.ok(a.median_cosine <= a.p90_cosine, "median ≤ p90");
  assert.ok(a.pairs > 0);
});

test("computeNoiseBaseline: null when fewer than 2 vectors", () => {
  assert.equal(computeNoiseBaseline([]), null);
  assert.equal(computeNoiseBaseline([{ node_id: "a", vector: [1, 0] }]), null);
  assert.equal(computeNoiseBaseline([{ node_id: "a" }, { node_id: "b" }]), null);
});

test("buildVectorIndex stamps noise_baseline into the payload meta", async () => {
  const graph = {
    nodes: [
      { id: "d:a", type: "Decision", title: "認証", summary: "認証基盤の判断" },
      { id: "d:b", type: "Decision", title: "決済", summary: "決済まわりの判断" },
      { id: "d:c", type: "Decision", title: "索引", summary: "索引の再構築" }
    ],
    edges: []
  };
  const payload = await buildVectorIndex({}, { provider: fakeProvider(4), graphObject: graph });
  assert.ok(payload.noise_baseline, "noise_baseline が打刻される");
  assert.equal(typeof payload.noise_baseline.median_cosine, "number");
  assert.equal(typeof payload.noise_baseline.p90_cosine, "number");
  assert.ok(payload.noise_baseline.pairs > 0);
});

// ── issue #34: vectorIndexMatchesGraph (graph/index 内容突合による鮮度判定) ──

import { vectorIndexMatchesGraph } from "./build-vector-index.ts";

const freshNodes = [
  { id: "decision:s:d1", type: "Decision", title: "D1", summary: "alpha" },
  { id: "decision:s:d2", type: "Decision", title: "D2", summary: "beta" }
];

function rowsFor(nodes, prefix = "") {
  return nodes.map((n) => ({ node_id: n.id, dimensions: 3, vector: [1, 0, 0], text_hash: vectorTextHash(n, prefix) }));
}

test("vectorIndexMatchesGraph: node_id 集合と text_hash が一致すれば fresh", () => {
  const graph = { nodes: freshNodes, edges: [] };
  assert.equal(vectorIndexMatchesGraph(graph, { rows: rowsFor(freshNodes) }), true);
});

test("vectorIndexMatchesGraph: ノード削除 (index に余分な row) は stale", () => {
  const graph = { nodes: [freshNodes[0]], edges: [] };
  assert.equal(vectorIndexMatchesGraph(graph, { rows: rowsFor(freshNodes) }), false);
});

test("vectorIndexMatchesGraph: ノード追加 (row 不足) は stale", () => {
  const graph = { nodes: freshNodes, edges: [] };
  assert.equal(vectorIndexMatchesGraph(graph, { rows: rowsFor([freshNodes[0]]) }), false);
});

test("vectorIndexMatchesGraph: 内容変更 (text_hash 不一致) は stale", () => {
  const changed = [freshNodes[0], { ...freshNodes[1], summary: "beta v2" }];
  assert.equal(vectorIndexMatchesGraph({ nodes: changed, edges: [] }, { rows: rowsFor(freshNodes) }), false);
});

test("vectorIndexMatchesGraph: prefix_policy は index 記録値で hash を計算する", () => {
  const graph = { nodes: freshNodes, edges: [] };
  const prefixed = { prefix_policy: { document: "search_document: ", query: "search_query: " }, rows: rowsFor(freshNodes, "search_document: ") };
  assert.equal(vectorIndexMatchesGraph(graph, prefixed), true, "記録された document 接頭辞込みで一致");
  const mismatched = { prefix_policy: { document: "search_document: ", query: "search_query: " }, rows: rowsFor(freshNodes, "") };
  assert.equal(vectorIndexMatchesGraph(graph, mismatched), false, "接頭辞不整合は stale");
});

test("vectorIndexMatchesGraph: text_hash を持たない旧形式 row は stale (安全側)", () => {
  const graph = { nodes: [freshNodes[0]], edges: [] };
  const rows = [{ node_id: freshNodes[0].id, dimensions: 3, vector: [1, 0, 0] }];
  assert.equal(vectorIndexMatchesGraph(graph, { rows }), false);
});

// ── issue #27: 一貫読み・開始時打刻・snapshot 比較書込み ─────────────────────

import { beginVaultWrite, endVaultWrite } from "./vault-lock.ts";
import { cacheDirForVault } from "./cli-env.ts";
import { buildAndWriteVectorIndex } from "./build-vector-index.ts";

// vault を root/vault に置く (cacheDirForVault が root/.graphrag/cache になり、
// 共有 tmpdir 直下に .graphrag を掘らない)。
function writeVaultUnder(root: string, graph): string {
  const vaultDir = path.join(root, "vault");
  for (const f of buildVaultFiles(graph)) {
    const abs = path.join(vaultDir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  return vaultDir;
}

test("issue #27: build は writer 進行中 (seq 奇数) に torn snapshot を読まず、確定後の graph から索引を作る", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vec27-consistent-"));
  const nodeOld = { id: "decision:s:tear", type: "Decision", title: "T", summary: "OLD-summary" };
  const nodeNew = { id: "decision:s:tear", type: "Decision", title: "T", summary: "NEW-summary" };
  try {
    const vaultDir = writeVaultUnder(root, { generated_at: "2026-01-01T00:00:00.000Z", nodes: [nodeOld], edges: [] });
    const cacheDir = cacheDirForVault(vaultDir);
    mkdirSync(cacheDir, { recursive: true });
    // writer 進行中を模擬 (vault-lock.test.ts の手法): 実 writer と同じく lock 保持下で
    // seq を奇数にしてから、少し遅れて vault を NEW に書き換えて seq を閉じる。lock 不在の
    // 奇数 seq は「静的な crash residue」として読まれる (vault-lock writerCrashed —
    // 敵対レビュー指摘A) ため、生き writer の再現には生きた PID の lock が必須。
    const lockPath = path.join(cacheDir, "vault.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    const began = beginVaultWrite(cacheDir);
    const writer = (async () => {
      await new Promise((r) => setTimeout(r, 30));
      for (const f of buildVaultFiles({ generated_at: "2026-01-01T00:00:00.000Z", nodes: [nodeNew], edges: [] })) {
        const abs = path.join(vaultDir, f.relPath);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, f.content);
      }
      endVaultWrite(cacheDir, began);
      rmSync(lockPath, { force: true });
    })();
    const payload = await buildVectorIndex({ vault: vaultDir }, { provider: fakeProvider(3) });
    await writer;
    const row = payload.rows.find((r) => r.node_id === "decision:s:tear");
    assert.ok(row, "node embedded");
    assert.equal(row.text_hash, vectorTextHash(nodeNew), "書込完了後の (NEW) snapshot から索引を作る");
    assert.notEqual(row.text_hash, vectorTextHash(nodeOld), "書込前の (OLD/torn) snapshot を読まない");
    assert.equal(payload.snapshot_seq, began + 1, "確定した seq (偶数) が payload に打刻される");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue #27: vault_head は build 開始時 snapshot の HEAD (embed 中に進んだ HEAD を打刻しない)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vec27-head-"));
  try {
    const vaultDir = writeVaultUnder(root, {
      generated_at: "2026-01-01T00:00:00.000Z",
      nodes: [{ id: "goal:acme:p99", type: "Goal", title: "p99", summary: "perf" }],
      edges: []
    });
    execFileSync("git", ["-C", vaultDir, "init", "-q"]);
    execFileSync("git", ["-C", vaultDir, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", vaultDir, "config", "user.name", "t"]);
    execFileSync("git", ["-C", vaultDir, "add", "."]);
    execFileSync("git", ["-C", vaultDir, "commit", "-q", "-m", "seed"]);
    const headA = execFileSync("git", ["-C", vaultDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    // embed 中に vault が commit されて HEAD が進む状況を fake provider で模擬する。
    let advanced = false;
    const provider: any = fakeProvider(3);
    const baseEmbed = provider.embed;
    provider.embed = async (text: string) => {
      if (!advanced) {
        advanced = true;
        execFileSync("git", ["-C", vaultDir, "commit", "-q", "--allow-empty", "-m", "concurrent mutation"]);
      }
      return baseEmbed(text);
    };
    const payload = await buildVectorIndex({ vault: vaultDir }, { provider });
    const headB = execFileSync("git", ["-C", vaultDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.notEqual(headA, headB, "embed 中に HEAD が進んでいる (前提)");
    assert.equal(payload.vault_head, headA, "rows と同じ build 開始時 snapshot の HEAD を打刻する (embed 後の HEAD ではない)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue #27: graph_fingerprint は rows と同一 snapshot の内容を指す (決定論・順序非依存・内容変更で変わる)", async () => {
  const { computeGraphFingerprint } = await import("./build-vector-index.ts") as any;
  const a = { id: "decision:s:a", type: "Decision", title: "A", summary: "alpha" };
  const b = { id: "decision:s:b", type: "Decision", title: "B", summary: "beta" };
  const g = { version: 1, nodes: [a, b], edges: [] };
  const payload = await buildVectorIndex({}, { provider: fakeProvider(3), graphObject: g });
  assert.equal(typeof payload.graph_fingerprint, "string");
  assert.equal(payload.graph_fingerprint, computeGraphFingerprint(g), "payload の fingerprint は build に使った graph のもの");
  assert.equal(
    computeGraphFingerprint({ nodes: [b, a], edges: [] }),
    computeGraphFingerprint({ nodes: [a, b], edges: [] }),
    "node 順序に依存しない (id 順ソート)"
  );
  assert.notEqual(
    computeGraphFingerprint({ nodes: [a, { ...b, summary: "beta v2" }], edges: [] }),
    computeGraphFingerprint(g),
    "内容が変われば fingerprint も変わる"
  );
});

// PR #41 [P2]: seq は同一 cache 世代内でしか単調でない。既存 index の seq が高くても、
// それだけでは skip しない — 既存が「現 graph と一致するか」(fingerprint fallback) で裁定する。
// 旧テスト「seq 10 の合成 index (rows: [] = 現 graph と不一致) を seq 0 の builder が
// 踏まない」は新仕様で意味が変わるため、以下の2本に分解した。

test("issue #27/PR #41: 既存 index が現 graph と一致するなら、古い snapshot の builder は seq に関係なく破棄される (stale builder 防止の維持)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vec27-lastwrite-"));
  const nodeNew = { id: "decision:s:x", type: "Decision", title: "X", summary: "NEW" };
  const nodeOld = { id: "decision:s:x", type: "Decision", title: "X", summary: "OLD" };
  try {
    // vault (現 graph) は NEW。より新しい snapshot (seq 10) から作られた、現 graph と
    // 内容一致する index が既に公開されている。
    const vaultDir = writeVaultUnder(root, { generated_at: "2026-01-01T00:00:00.000Z", nodes: [nodeNew], edges: [] });
    const out = path.join(root, ".graphrag", "cache", "vector.json");
    mkdirSync(path.dirname(out), { recursive: true });
    const currentNodes = (await import("./import-vault.ts") as any).importVault(vaultDir).nodes;
    const newer = {
      version: 1,
      provider: "other",
      snapshot_seq: 10,
      graph_fingerprint: "f".repeat(64),
      rows: currentNodes.map((n: any) => ({ node_id: n.id, dimensions: 3, vector: [1, 0, 0], text_hash: vectorTextHash(n) }))
    };
    writeFileSync(out, JSON.stringify(newer));
    // 自分は OLD snapshot (seq 0) から build した stale builder。
    const res: any = await buildAndWriteVectorIndex(
      { vault: vaultDir, out },
      { provider: fakeProvider(3), graphObject: { nodes: [nodeOld], edges: [] }, snapshotSeq: 0, previousIndex: null }
    );
    assert.equal(res.skipped, true, "古い builder の書き込みは破棄される");
    const onDisk = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(onDisk.snapshot_seq, 10, "新しい index は踏み潰されない");
    assert.equal(onDisk.provider, "other", "ファイル内容は不変");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PR #41: cache 初期化後 (seq リセット)、現 graph と一致しない高 seq の既存 index は低 seq の builder が上書きできる (恒久 skip の解消)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vec41-reinit-"));
  try {
    const vaultDir = writeVaultUnder(root, {
      generated_at: "2026-01-01T00:00:00.000Z",
      nodes: [{ id: "decision:s:x", type: "Decision", title: "X", summary: "x" }],
      edges: []
    });
    const out = path.join(root, ".graphrag", "cache", "vector.json");
    mkdirSync(path.dirname(out), { recursive: true });
    // cache 初期化前の旧世代 index: seq 10 だが rows は現 graph と不一致 (別 seq 空間の遺物)。
    const relic = { version: 1, provider: "other", snapshot_seq: 10, graph_fingerprint: "f".repeat(64), rows: [] };
    writeFileSync(out, JSON.stringify(relic));
    // cache 初期化後の builder: 現 seq ファイル無し = 0 から build。
    const res: any = await buildAndWriteVectorIndex({ vault: vaultDir, out }, { provider: fakeProvider(3) });
    assert.equal(res.skipped, false, "現 graph と乖離した index を高 seq が恒久に守らない");
    const onDisk = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(onDisk.rows.length, 1, "現 graph の index で置き換わる");
    assert.equal(onDisk.snapshot_seq, 0, "新しい seq 空間の打刻に置き換わる");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PR #41 再指摘: 現 graph と一致する低 seq の既存 index は、旧世代の高 seq builder に踏み潰されない (seq 逆向きの穴)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vec41-revdir-"));
  const nodeNew = { id: "decision:s:x", type: "Decision", title: "X", summary: "NEW" };
  const nodeOld = { id: "decision:s:x", type: "Decision", title: "X", summary: "OLD" };
  try {
    // vault (現 graph) は NEW。cache 初期化後の新 seq 空間 (seq 0) で build された、
    // 現 graph と内容一致する fresh な index が既に公開されている。
    const vaultDir = writeVaultUnder(root, { generated_at: "2026-01-01T00:00:00.000Z", nodes: [nodeNew], edges: [] });
    const out = path.join(root, ".graphrag", "cache", "vector.json");
    mkdirSync(path.dirname(out), { recursive: true });
    const currentNodes = (await import("./import-vault.ts") as any).importVault(vaultDir).nodes;
    const fresh = {
      version: 1,
      provider: "other",
      snapshot_seq: 0,
      graph_fingerprint: "e".repeat(64),
      rows: currentNodes.map((n: any) => ({ node_id: n.id, dimensions: 3, vector: [1, 0, 0], text_hash: vectorTextHash(n) }))
    };
    writeFileSync(out, JSON.stringify(fresh));
    // 自分は cache 初期化前の旧 seq 空間 (seq 100) で OLD snapshot から build した stale builder。
    // 現行の高速パス (existing.seq 0 <= payload.seq 100 → 即 no-regress) だと書けてしまう。
    const res: any = await buildAndWriteVectorIndex(
      { vault: vaultDir, out },
      { provider: fakeProvider(3), graphObject: { nodes: [nodeOld], edges: [] }, snapshotSeq: 100, previousIndex: null }
    );
    assert.equal(res.skipped, true, "旧世代の高 seq builder は現 graph と一致する index を上書きできない");
    const onDisk = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(onDisk.snapshot_seq, 0, "fresh な index は踏み潰されない");
    assert.equal(onDisk.provider, "other", "ファイル内容は不変");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue #27: fingerprint 一致は seq より先に判定され、退行ではない (同一 snapshot 内容の上書きは無害)", async () => {
  const { indexWriteWouldRegress } = await import("./build-vector-index.ts") as any;
  const fp = "a".repeat(64);
  const existing = { version: 1, snapshot_seq: 10, graph_fingerprint: fp, rows: [] };
  const payload = { version: 1, snapshot_seq: 0, graph_fingerprint: fp, rows: [] };
  assert.equal(await indexWriteWouldRegress(payload, existing), false, "fingerprint 一致 → seq が高くても退行扱いしない");
});

test("issue #27: 自分の snapshot の方が新しければ従来どおり上書きする (後勝ちの正しい側)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vec27-newer-"));
  try {
    const vaultDir = writeVaultUnder(root, {
      generated_at: "2026-01-01T00:00:00.000Z",
      nodes: [{ id: "decision:s:x", type: "Decision", title: "X", summary: "x" }],
      edges: []
    });
    const cacheDir = cacheDirForVault(vaultDir);
    mkdirSync(cacheDir, { recursive: true });
    const out = path.join(cacheDir, "vector.json");
    writeFileSync(out, JSON.stringify({ version: 1, provider: "other", snapshot_seq: 0, graph_fingerprint: "0".repeat(64), rows: [] }));
    // 現在の seq を 2 に進める (自分の snapshot の方が新しい)。
    endVaultWrite(cacheDir, beginVaultWrite(cacheDir));
    const res: any = await buildAndWriteVectorIndex({ vault: vaultDir, out }, { provider: fakeProvider(3) });
    assert.equal(res.skipped, false);
    const onDisk = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(onDisk.snapshot_seq, 2, "新しい snapshot の index で置き換わる");
    assert.equal(onDisk.rows.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue #27: seq 比較不能でも、既存 index が現 graph と一致していれば古い builder は破棄される (fingerprint 優先)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vec27-fp-"));
  const nodeNew = { id: "decision:s:x", type: "Decision", title: "X", summary: "NEW" };
  const nodeOld = { id: "decision:s:x", type: "Decision", title: "X", summary: "OLD" };
  try {
    // vault (現 graph) は NEW。
    const vaultDir = writeVaultUnder(root, { generated_at: "2026-01-01T00:00:00.000Z", nodes: [nodeNew], edges: [] });
    const out = path.join(root, ".graphrag", "cache", "vector.json");
    mkdirSync(path.dirname(out), { recursive: true });
    // 既存 index は現 graph (NEW) と一致する内容 (別 builder が先に最新を公開済み)。
    // seq 打刻は無い = seq では比較できない。
    const currentNodes = (await import("./import-vault.ts") as any).importVault(vaultDir).nodes;
    const freshIndex = {
      version: 1,
      provider: "other",
      rows: currentNodes.map((n: any) => ({ node_id: n.id, dimensions: 3, vector: [1, 0, 0], text_hash: vectorTextHash(n) }))
    };
    writeFileSync(out, JSON.stringify(freshIndex));
    // 自分は OLD snapshot (graphObject 直渡し = seq 不明) から build。
    const res: any = await buildAndWriteVectorIndex(
      { vault: vaultDir, out },
      { provider: fakeProvider(3), graphObject: { nodes: [nodeOld], edges: [] }, previousIndex: null }
    );
    assert.equal(res.skipped, true, "現 graph と一致する index を古い snapshot で踏み潰さない");
    const onDisk = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(onDisk.provider, "other", "ファイル内容は不変");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── issue #31: 逐次 embed → embedMany バッチ ─────────────────────────────────
test("embedNodesIncremental: miss 分を node 順どおり embedMany で 1 バッチ送出 (再利用行はバッチに載らない)", async () => {
  const batches: string[][] = [];
  const provider: any = {
    id: "fake", capability: "semantic", semantic: true, dimensions: 3,
    metadata: { endpoint: "http://fake/v1/embeddings", model: "fake-model" },
    embed: async (text: string) => { batches.push([text]); return [text.length % 5, 1, 0]; },
    embedMany: async (texts: string[]) => { batches.push([...texts]); return texts.map((t) => [t.length % 5, 1, 0]); }
  };
  const a = { id: "decision:s:a", type: "Decision", title: "A", summary: "alpha" };
  const b = { id: "decision:s:b", type: "Decision", title: "B", summary: "beta" };
  const c = { id: "decision:s:c", type: "Decision", title: "C", summary: "gamma" };
  const prev = [{ node_id: "decision:s:b", dimensions: 3, vector: [9, 9, 9], text_hash: vectorTextHash(b) }];
  const rows = await embedNodesIncremental([a, b, c], provider, prev);
  assert.equal(batches.length, 1, "miss 2 件は 1 回の embedMany バッチ (現行は 1 件ずつ = red)");
  assert.deepEqual(batches[0], [nodeVectorText(a), nodeVectorText(c)], "バッチ内容は node 順の miss テキスト");
  assert.deepEqual(
    rows.map((r: any) => r.node_id),
    ["decision:s:a", "decision:s:b", "decision:s:c"],
    "rows は node 順 (決定論的順序を維持)"
  );
  assert.deepEqual(rows[1].vector, [9, 9, 9], "unchanged (text_hash 一致) は再利用しバッチに含めない");
  assert.equal(rows[1].text_hash, vectorTextHash(b));
});

test("embedNodesIncremental: documentPrefix はバッチの各 miss テキストにも付く", async () => {
  const batches: string[][] = [];
  const provider: any = {
    id: "fake", capability: "semantic", semantic: true, dimensions: 3,
    metadata: { endpoint: "http://fake/v1/embeddings", model: "fake-model" },
    embed: async (text: string) => { batches.push([text]); return [1, 0, 0]; },
    embedMany: async (texts: string[]) => { batches.push([...texts]); return texts.map(() => [1, 0, 0]); }
  };
  const a = { id: "decision:s:a", type: "Decision", title: "A", summary: "alpha" };
  const b = { id: "decision:s:b", type: "Decision", title: "B", summary: "beta" };
  const rows = await embedNodesIncremental([a, b], provider, [], "search_document: ");
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], [`search_document: ${nodeVectorText(a)}`, `search_document: ${nodeVectorText(b)}`]);
  assert.equal(rows[0].text_hash, vectorTextHash(a, "search_document: "), "text_hash は prefix 込み (従来どおり)");
});
