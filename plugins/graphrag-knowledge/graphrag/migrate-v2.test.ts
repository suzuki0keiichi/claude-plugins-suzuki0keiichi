import assert from "node:assert/strict";
import test from "node:test";
import { canonicalType } from "./schema.ts";
import { migrateV2Graph, compareGraphs, reimportVaultFiles, runMigration, main } from "./migrate-v2.ts";
import { buildVaultFiles } from "./build-vault.ts";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("canonicalType maps axis-2 aliases to canonical and passes others through", () => {
  assert.equal(canonicalType("Stratum"), "Layer");
  assert.equal(canonicalType("Vein"), "Concern");
  assert.equal(canonicalType("Pocket"), "Component");
  // 既に canonical / 非軸2型はそのまま
  assert.equal(canonicalType("Layer"), "Layer");
  assert.equal(canonicalType("Decision"), "Decision");
  assert.equal(canonicalType("Goal"), "Goal");
  // undefined は undefined
  assert.equal(canonicalType(undefined), undefined);
});

test("migrateV2Graph canonicalizes axis-2 type+id, leaves non-axis-2 verbatim", () => {
  const v2 = {
    version: 1,
    generated_at: "2026-05-29T00:00:00.000Z",
    nodes: [
      { id: "system:acme", type: "System", title: "Acme" },
      { id: "concern:acme:auth", type: "Concern", title: "認証", summary: "横断" },
      { id: "component:acme:api", type: "Component", title: "API" },
      { id: "layer:acme:domain", type: "Layer", title: "ドメイン層" },
      { id: "decision:acme:shard", type: "Decision", title: "shard", confidence: 1 }
    ],
    edges: [
      { id: "e:1", type: "evidenced_by", from: "concern:acme:auth", to: "component:acme:api" }
    ]
  };
  const out = migrateV2Graph(v2);
  // 軸2 type は既に canonical (System が落ちて index が 1 つ前へ)
  assert.equal(out.nodes[0].type, "Concern");
  assert.equal(out.nodes[1].type, "Component");
  assert.equal(out.nodes[2].type, "Layer");
  // 軸2 id も既に canonical — 変換不要
  assert.equal(out.nodes[0].id, "concern:acme:auth");
  assert.equal(out.nodes[1].id, "component:acme:api");
  assert.equal(out.nodes[2].id, "layer:acme:domain");
  // v3.3: System root は migrate が落とす (vault=scope)
  assert.ok(!out.nodes.some((n) => n.type === "System"), "System root is dropped");
  // 非軸2型・他フィールド・top-level メタは不変
  assert.equal(out.nodes[3].type, "Decision");
  assert.equal(out.nodes[3].id, "decision:acme:shard");
  assert.equal(out.nodes[3].confidence, 1);
  assert.equal(out.nodes[0].summary, "横断");
  assert.equal(out.version, 1);
  assert.equal(out.generated_at, "2026-05-29T00:00:00.000Z");
  // edge の from/to は変換不要 (既に canonical)
  assert.equal(out.edges[0].id, "e:1");
  assert.equal(out.edges[0].type, "evidenced_by");
  assert.equal(out.edges[0].from, "concern:acme:auth");
  assert.equal(out.edges[0].to, "component:acme:api");
  // 入力を破壊しない
  assert.equal(v2.nodes[1].type, "Concern");
  assert.equal(v2.nodes[1].id, "concern:acme:auth");
  assert.equal(v2.edges[0].from, "concern:acme:auth");
});

test("compareGraphs returns [] when graphs match, reports losses otherwise", () => {
  const a = {
    nodes: [{ id: "n1", type: "Concern", title: "T" }, { id: "n2", type: "File" }],
    edges: [{ id: "e1", type: "contains", from: "n1", to: "n2" }]
  };
  // 完全一致 → 欠損ゼロ
  assert.deepEqual(compareGraphs(a, { nodes: [...a.nodes], edges: [...a.edges] }), []);

  // node 欠損 + edge 欠損
  const lossy = { nodes: [a.nodes[0]], edges: [] };
  const failures = compareGraphs(a, lossy);
  assert.ok(failures.some((f) => f.includes("missing node n2")), failures.join("; "));
  assert.ok(failures.some((f) => f.includes("missing edge e1")), failures.join("; "));

  // フィールド相違
  const changed = {
    nodes: [{ id: "n1", type: "Concern", title: "違う" }, a.nodes[1]],
    edges: [...a.edges]
  };
  const diffs = compareGraphs(a, changed);
  assert.ok(diffs.some((f) => f.includes("node n1")), diffs.join("; "));
});

test("reimportVaultFiles reconstructs graph from in-memory files (no disk)", () => {
  const graph = {
    nodes: [
      { id: "system:acme", type: "System", title: "Acme" },
      { id: "concern:acme:auth", type: "Concern", title: "認証", summary: "横断" },
      { id: "file:acme:a.ts", type: "File", title: "a.ts" }
    ],
    edges: [
      { id: "e:1", type: "evidenced_by", from: "concern:acme:auth", to: "file:acme:a.ts" }
    ]
  };
  const files = buildVaultFiles(graph);
  const out = reimportVaultFiles(files);
  assert.equal(out.nodes.length, 3);
  assert.equal(out.edges.length, 1);
  const byId = new Map(out.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("concern:acme:auth").type, "Concern");
  assert.equal(out.edges[0].id, "e:1");
});

test("runMigration: v2 (Layer/Concern/Component + System root) migrates and round-trips with zero loss", () => {
  const v2 = {
    version: 1,
    generated_at: "2026-05-29T00:00:00.000Z",
    nodes: [
      { id: "system:acme", type: "System", title: "Acme" },
      { id: "decision:acme:shard", type: "Decision", title: "shard 採用",
        summary: "s", description: "本文\n複数行", confidence: 1 },
      { id: "concern:acme:auth", type: "Concern", title: "認証", summary: "横断関心" },
      { id: "component:acme:api", type: "Component", title: "API 層" },
      { id: "layer:acme:domain", type: "Layer", title: "ドメイン" },
      { id: "file:acme:a.ts", type: "File", title: "a.ts" }
    ],
    edges: [
      { id: "e:1", type: "contains", from: "system:acme", to: "decision:acme:shard" },
      { id: "e:2", type: "contains", from: "system:acme", to: "concern:acme:auth" },
      { id: "e:3", type: "evidenced_by", from: "concern:acme:auth", to: "file:acme:a.ts" },
      { id: "e:4", type: "evidenced_by", from: "component:acme:api", to: "file:acme:a.ts" }
    ]
  };
  const r = runMigration(v2);
  // 移行後グラフは schema 的に valid (canonical 型 + 既存 edge ペア)
  assert.deepEqual(r.validationFailures, [], r.validationFailures.join("; "));
  // 往復欠損ゼロ (= 移行完了ゲート)
  assert.deepEqual(r.lossReport, [], r.lossReport.join("; "));
  // 軸2 は既に canonical — type も id もそのまま
  const byId = new Map(r.migrated.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("concern:acme:auth").type, "Concern");
  assert.equal(byId.get("component:acme:api").type, "Component");
  assert.equal(byId.get("layer:acme:domain").type, "Layer");
  // v3.3: System root と contains は migrate が落とす (vault=scope)
  assert.ok(!byId.has("system:acme"), "System root dropped");
  assert.ok(!r.migrated.edges.some((e) => e.type === "contains"), "contains dropped");
  // 軸2ノードを指す edge は既に canonical id
  const e3 = r.migrated.edges.find((e) => e.id === "e:3");
  assert.equal(e3.from, "concern:acme:auth");
  // vault ファイルが canonical フォルダに配置される
  assert.ok(r.files.some((f) => f.relPath.startsWith("Concern/")));
  assert.ok(r.files.some((f) => f.relPath.startsWith("Component/")));
});

test("main reads graph.json, writes v3 vault, does not reject on zero-loss", () => {
  const work = mkdtempSync(path.join(tmpdir(), "migrate-main-"));
  const graphPath = path.join(work, "graph.json");
  const vaultDir = path.join(work, "vault");
  writeFileSync(graphPath, JSON.stringify({
    generated_at: "2026-05-29T00:00:00.000Z",
    nodes: [
      { id: "system:acme", type: "System", title: "Acme" },
      { id: "concern:acme:auth", type: "Concern", title: "認証", summary: "s" },
      { id: "file:acme:a.ts", type: "File", title: "a.ts" }
    ],
    edges: [
      { id: "e:1", type: "contains", from: "system:acme", to: "concern:acme:auth" },
      { id: "e:2", type: "evidenced_by", from: "concern:acme:auth", to: "file:acme:a.ts" }
    ]
  }));
  let code: number | undefined;
  const origExit = process.exit;
  // @ts-ignore — テスト中の exit 捕捉
  process.exit = ((c?: number) => { code = c; throw new Error(`exit:${c}`); });
  try {
    main([graphPath, vaultDir]);
  } catch (e) {
    if (!String(e).includes("exit:")) throw e;
  } finally {
    process.exit = origExit;
  }
  assert.notEqual(code, 1, "should not reject a clean migration");
  // canonical フォルダに書かれている
  assert.ok(existsSync(path.join(vaultDir, "Concern")), "Concern/ folder written");
  rmSync(work, { recursive: true, force: true });
});

test("main rejects (exit 1) and writes no vault when graph is invalid (validateGraph path)", () => {
  const work = mkdtempSync(path.join(tmpdir(), "migrate-main-bad-"));
  const graphPath = path.join(work, "graph.json");
  const vaultDir = path.join(work, "vault");
  // edge が存在しない node を参照 → validateGraph が落とす (vault を書かない)。
  // lossReport 経路の reject は別テスト "main rejects via lossReport" が担う。
  writeFileSync(graphPath, JSON.stringify({
    generated_at: "2026-05-29T00:00:00.000Z",
    nodes: [{ id: "decision:acme:x", type: "Decision", title: "X" }],
    edges: [{ id: "e:1", type: "has_premise", from: "decision:acme:x", to: "ghost:missing" }]
  }));
  let code: number | undefined;
  const origExit = process.exit;
  // @ts-ignore
  process.exit = ((c?: number) => { code = c; throw new Error(`exit:${c}`); });
  try {
    main([graphPath, vaultDir]);
  } catch (e) {
    if (!String(e).includes("exit:")) throw e;
  } finally {
    process.exit = origExit;
  }
  assert.equal(code, 1, "should reject invalid migration");
  assert.ok(!existsSync(vaultDir), "vault must not be written on reject");
  rmSync(work, { recursive: true, force: true });
});

test("lossReport fires independently of validateGraph (valid graph that loses on round-trip)", () => {
  // node が予約名フィールド (links) を持つ: validateGraph は任意フィールドを気にしないが
  // import-vault は links / graph_edges を decoration として捨てる。よって valid のまま
  // round-trip で欠損が出る。これが build-vault フォーマット起因の「黙殺欠損」を
  // lossReport ゲートが validateGraph と独立に捕捉できる事の証明。
  const v2 = {
    generated_at: "2026-05-29T00:00:00.000Z",
    nodes: [
      { id: "decision:acme:x", type: "Decision", title: "X", links: { foo: ["bar"] } }
    ],
    edges: []
  };
  const r = runMigration(v2);
  assert.deepEqual(r.validationFailures, [], "validateGraph should pass (arbitrary fields are fine)");
  assert.ok(r.lossReport.length > 0, "lossReport must catch the round-trip loss");
  assert.ok(r.lossReport.some((f) => f.includes("decision:acme:x")), r.lossReport.join("; "));
});

test("main rejects via lossReport (not validateGraph) and writes no vault", () => {
  const work = mkdtempSync(path.join(tmpdir(), "migrate-main-loss-"));
  const graphPath = path.join(work, "graph.json");
  const vaultDir = path.join(work, "vault");
  // 上と同じ valid-but-lossy graph (links 予約名フィールド)
  writeFileSync(graphPath, JSON.stringify({
    generated_at: "2026-05-29T00:00:00.000Z",
    nodes: [
      { id: "decision:acme:x", type: "Decision", title: "X", links: { foo: ["bar"] } }
    ],
    edges: []
  }));
  let code: number | undefined;
  const origExit = process.exit;
  // @ts-ignore
  process.exit = ((c?: number) => { code = c; throw new Error(`exit:${c}`); });
  try {
    main([graphPath, vaultDir]);
  } catch (e) {
    if (!String(e).includes("exit:")) throw e;
  } finally {
    process.exit = origExit;
  }
  assert.equal(code, 1, "should reject on round-trip loss");
  assert.ok(!existsSync(vaultDir), "vault must not be written when round-trip loses data");
  rmSync(work, { recursive: true, force: true });
});

test("migrateV2Graph handles edge cases: empty graph, unknown/undefined type, edges non-mutation", () => {
  // 空 graph (nodes/edges 未定義)
  const empty = migrateV2Graph({});
  assert.deepEqual(empty.nodes, []);
  assert.deepEqual(empty.edges, []);

  // 未知 type は passthrough、type undefined は触らない
  const g = {
    nodes: [
      { id: "a", type: "Mystery", title: "?" },
      { id: "b", title: "no type" }
    ],
    edges: [{ id: "e1", type: "discussed_in", from: "a", to: "b" }]
  };
  const out = migrateV2Graph(g);
  assert.equal(out.nodes[0].type, "Mystery");
  assert.equal("type" in out.nodes[1], false, "type undefined stays absent");
  // edges 配列は非破壊 (新オブジェクト) かつ内容同一
  assert.notEqual(out.edges, g.edges);
  assert.notEqual(out.edges[0], g.edges[0]);
  assert.deepEqual(out.edges[0], g.edges[0]);
  // contains は機械的に落ちる
  const dropped = migrateV2Graph({ nodes: [], edges: [{ id: "e2", type: "contains", from: "a", to: "b" }] });
  assert.deepEqual(dropped.edges, []);
});

test("migrateV2Graph keeps already-canonical axis-2 ids and rewires edge from/to", () => {
  const v2 = {
    nodes: [
      { id: "system:acme", type: "System", title: "Acme" },
      { id: "concern:acme:auth", type: "Concern", title: "認証" },
      { id: "component:acme:api", type: "Component", title: "API" },
      { id: "layer:acme:domain", type: "Layer", title: "ドメイン" },
      { id: "decision:acme:x", type: "Decision", title: "X" }
    ],
    edges: [
      { id: "e:1", type: "evidenced_by", from: "concern:acme:auth", to: "component:acme:api" },
      { id: "e:2", type: "contains", from: "system:acme", to: "layer:acme:domain" },
      { id: "e:3", type: "has_premise", from: "decision:acme:x", to: "concern:acme:auth" }
    ]
  };
  const out = migrateV2Graph(v2);
  const byId = new Map(out.nodes.map((n) => [n.id, n]));
  // 軸2 id は既に canonical — 変換不要
  assert.ok(byId.has("concern:acme:auth"));
  assert.ok(byId.has("component:acme:api"));
  assert.ok(byId.has("layer:acme:domain"));
  assert.equal(byId.get("concern:acme:auth").type, "Concern");
  // 軸2以外の id は不変、System root は落ちる
  assert.ok(!byId.has("system:acme"));
  assert.ok(byId.has("decision:acme:x"));
  // edge の from/to は既に canonical (edge id 自体は不変)
  const e1 = out.edges.find((e) => e.id === "e:1");
  assert.equal(e1.from, "concern:acme:auth");
  assert.equal(e1.to, "component:acme:api");
  // contains (e:2) は落ちる
  assert.ok(!out.edges.some((e) => e.id === "e:2"), "contains dropped");
  const e3 = out.edges.find((e) => e.id === "e:3");
  assert.equal(e3.from, "decision:acme:x");
  assert.equal(e3.to, "concern:acme:auth");
  // 入力非破壊
  assert.equal(v2.nodes[1].id, "concern:acme:auth");
  assert.equal(v2.edges[0].from, "concern:acme:auth");
});

test("migrateV2Graph applies caller-supplied semantic overrides (no blind rules)", () => {
  const v2 = {
    nodes: [
      { id: "requirement:s:x", type: "Requirement", title: "T" },
      { id: "decision:s:d", type: "Decision", title: "D" },
      { id: "concern:s:c", type: "Concern", title: "C" } // override 無し → 機械変換
    ],
    edges: [
      { id: "e1", type: "constrained_by", from: "requirement:s:x", to: "decision:s:d" }
    ]
  };
  const out = migrateV2Graph(v2, {
    nodeOverrides: { "requirement:s:x": { type: "Goal", id: "goal:s:x" } },
    edgeOverrides: { "e1": { type: "has_premise", from: "decision:s:d", to: "goal:s:x" } }
  });
  const n = out.nodes.find((x) => x.id === "goal:s:x");
  assert.equal(n.type, "Goal");
  assert.equal(n.title, "T", "他フィールドは保持");
  // override 無しのノードは既に canonical (Concern/concern: は変換不要)
  const c = out.nodes.find((x) => x.id === "concern:s:c");
  assert.equal(c.type, "Concern");
  // edge は override どおり (向き反転 + 型変更)
  const e = out.edges[0];
  assert.equal(e.type, "has_premise");
  assert.equal(e.from, "decision:s:d");
  assert.equal(e.to, "goal:s:x");
});
