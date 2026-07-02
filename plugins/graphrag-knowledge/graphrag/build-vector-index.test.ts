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

test("buildVectorIndex rejects vault + base together (loud, no silent broken delta)", async () => {
  const dir = writeVault({ nodes: [{ id: "system:acme", type: "System", title: "A" }], edges: [] });
  try {
    await assert.rejects(
      () => buildVectorIndex({ vault: dir, base: "/whatever.json" }, { provider: fakeProvider(3) }),
      /vault \+ base/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
