import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildVaultFiles } from "./build-vault.ts";
import { importVault, importVaultFile } from "./import-vault.ts";
import { writeVaultDelta } from "./mutate-vault.ts";
import { validateGraph } from "./schema.ts";

function writeVault(files: { relPath: string; content: string }[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "graphrag-vault-"));
  for (const f of files) {
    const abs = path.join(dir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  return dir;
}

function sortById<T extends { id?: unknown }>(arr: T[]): T[] {
  return [...arr].sort((a, b) =>
    String(a.id).localeCompare(String(b.id))
  );
}

type Rec = Record<string, unknown>;

function canonicalize(graph: {
  nodes?: Rec[];
  edges?: Rec[];
}): { nodes: Map<string, Rec>; edges: Map<string, Rec> } {
  const nodes = new Map<string, Rec>();
  for (const n of graph.nodes ?? []) nodes.set(String(n.id), n);
  const edges = new Map<string, Rec>();
  for (const e of graph.edges ?? []) edges.set(String(e.id), e);
  return { nodes, edges };
}

test("synthetic graph round-trips losslessly (nodes + edges)", () => {
  const graph = {
    generated_at: "2026-05-17T00:00:00.000Z",
    nodes: [
      {
        id: "decision:graphrag:rt",
        type: "Decision",
        title: "往復テスト用 \"引用\" 入り",
        summary: "要約",
        description: "説明本文\n複数行も\nありうる",
        raw_content: "RAW 一次情報\n\n空行を含む\n末尾なし",
        confidence: 1,
        aliases: ["alias-a", "別名B"],
        display: { ja: { aliases: ["短ラベル", "別表記"] } }
      },
      {
        id: "risk:graphrag:rt",
        type: "Risk",
        title: "リスク",
        summary: "リスク要約",
        confidence: "0.9"
      }
    ],
    edges: [
      {
        id: "edge:rt:addresses",
        type: "addresses",
        from: "decision:graphrag:rt",
        to: "risk:graphrag:rt",
        summary: "対処する",
        updated_at: "2026-05-17T00:00:00+09:00"
      }
    ]
  };
  const files = buildVaultFiles(graph);
  const dir = writeVault(files);
  try {
    const out = importVault(dir);
    const A = canonicalize(graph);
    const B = canonicalize(out);

    assert.equal(B.nodes.size, A.nodes.size, "node count");
    for (const [id, src] of A.nodes) {
      const got = B.nodes.get(id);
      assert.ok(got, `missing node ${id}`);
      // Nodes without an explicit generated_at inherit the graph-level stamp via
      // the banner; the importer recovers it. Compare against that expectation.
      assert.deepEqual(
        got,
        { ...src, generated_at: graph.generated_at },
        `node mismatch ${id}`
      );
    }
    assert.equal(B.edges.size, A.edges.size, "edge count");
    for (const [id, src] of A.edges) {
      assert.deepEqual(B.edges.get(id), src, `edge mismatch ${id}`);
    }
    // confidence number vs string distinction preserved.
    assert.strictEqual(B.nodes.get("decision:graphrag:rt").confidence, 1);
    assert.strictEqual(B.nodes.get("risk:graphrag:rt").confidence, "0.9");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FalkorDB graph.json fixture round-trips losslessly", (t) => {
  // Optional real-data check. The spin-off carries no graphrag data/graph.json
  // (it is graphrag's knowledge content, not skill code). Skip when absent;
  // the synthetic round-trip test below is the always-on change gate.
  const graphPath = path.join(process.cwd(), "data", "graph.json");
  if (!existsSync(graphPath)) {
    t.skip("data/graph.json absent (graphrag-specific fixture; synthetic test covers the gate)");
    return;
  }
  const graph = JSON.parse(readFileSync(graphPath, "utf8"));
  const files = buildVaultFiles(graph);
  const dir = writeVault(files);
  try {
    const out = importVault(dir);

    const A = canonicalize(graph);
    const B = canonicalize(out);

    // ---- nodes: every id, every field deep-equal ----
    assert.equal(
      B.nodes.size,
      A.nodes.size,
      `node count: expected ${A.nodes.size} got ${B.nodes.size}`
    );
    const nodeDiffs: string[] = [];
    for (const [id, src] of A.nodes) {
      const got = B.nodes.get(id);
      if (!got) {
        nodeDiffs.push(`missing node ${id}`);
        continue;
      }
      try {
        assert.deepEqual(got, src);
      } catch {
        const keys = new Set([
          ...Object.keys(src),
          ...Object.keys(got)
        ]);
        for (const k of keys) {
          if (JSON.stringify(src[k]) !== JSON.stringify(got[k])) {
            nodeDiffs.push(
              `${id}.${k}: src=${JSON.stringify(src[k])} got=${JSON.stringify(
                got[k]
              )}`
            );
          }
        }
      }
    }
    assert.equal(
      nodeDiffs.length,
      0,
      `node field diffs:\n${nodeDiffs.slice(0, 20).join("\n")}`
    );

    // ---- edges: id-keyed set equality, all fields ----
    assert.equal(
      B.edges.size,
      A.edges.size,
      `edge count: expected ${A.edges.size} got ${B.edges.size}`
    );
    const edgeDiffs: string[] = [];
    for (const [id, src] of A.edges) {
      const got = B.edges.get(id);
      if (!got) {
        edgeDiffs.push(`missing edge ${id}`);
        continue;
      }
      try {
        assert.deepEqual(got, src);
      } catch {
        edgeDiffs.push(
          `${id}: src=${JSON.stringify(src)} got=${JSON.stringify(got)}`
        );
      }
    }
    assert.equal(
      edgeDiffs.length,
      0,
      `edge diffs:\n${edgeDiffs.slice(0, 20).join("\n")}`
    );

    // Sanity: the fixture is the full canonical graph, not a stub. Guards
    // against an empty/short-circuit pass. Equality of A.size and B.size is
    // already asserted above; these lower bounds keep the gate meaningful
    // even if the fixture grows.
    assert.ok(
      A.nodes.size >= 400,
      `fixture node count too small: ${A.nodes.size}`
    );
    assert.ok(
      A.edges.size >= 1000,
      `fixture edge count too small: ${A.edges.size}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vault banner declares vault as canonical, not FalkorDB", () => {
  const files = buildVaultFiles({
    generated_at: "2026-05-29T00:00:00.000Z",
    nodes: [{ id: "decision:sys:x", type: "Decision", title: "T" }],
    edges: []
  });
  for (const f of files) {
    assert.ok(!f.content.includes("正本は FalkorDB"), `${f.relPath}: banner must not call FalkorDB canonical`);
    assert.ok(f.content.includes("正本は vault"), `${f.relPath}: banner must declare vault canonical`);
  }
});

test("v3 graph (Goal/crosscut/new edges) round-trips losslessly", () => {
  const graph = {
    generated_at: "2026-05-29T00:00:00.000Z",
    nodes: [
      { id: "goal:acme:p99", type: "Goal", title: "p99 < 200ms", summary: "性能ゴール",
        category: "performance-efficiency" },
      { id: "decision:acme:shard", type: "Decision", title: "shard 採用", summary: "s" },
      { id: "vein:acme:auth", type: "Vein", title: "認証", summary: "横断" },
      { id: "file:acme:a.ts", type: "File", title: "a.ts" }
    ],
    edges: [
      { id: "e:1", type: "has_premise", from: "decision:acme:shard", to: "goal:acme:p99" },
      { id: "e:3", type: "evidenced_by", from: "vein:acme:auth", to: "file:acme:a.ts" }
    ]
  };
  const files = buildVaultFiles(graph);
  const dir = writeVault(files);
  try {
    const out = importVault(dir);
    const A = canonicalize(graph);
    const B = canonicalize(out);
    assert.equal(B.nodes.size, A.nodes.size, "node count");
    for (const [id, src] of A.nodes) {
      const got = B.nodes.get(id);
      assert.ok(got, `node ${id} missing after import`);
      // Banner-derived generated_at (graph-level stamp) round-trips onto the node.
      assert.deepEqual(got, { ...src, generated_at: graph.generated_at }, `node ${id}`);
    }
    assert.equal(B.edges.size, A.edges.size, "edge count");
    for (const [id, src] of A.edges) assert.deepEqual(B.edges.get(id), src, `edge ${id}`);
    // validateGraph で v3 型 + 新 edge が通る
    assert.deepEqual(validateGraph(graph), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scopes frontmatter attribute round-trips verbatim", () => {
  const graph = {
    generated_at: "2026-05-29T00:00:00.000Z",
    nodes: [
      { id: "ok:acme:q3-scope", type: "OperationalKnowledge", title: "Q3", summary: "s",
        scopes: ["system:acme:tenant-svc", "system:acme:billing"] }
    ],
    edges: []
  };
  const files = buildVaultFiles(graph);
  const dir = writeVault(files);
  try {
    const out = importVault(dir);
    const got = canonicalize(out).nodes.get("ok:acme:q3-scope");
    assert.ok(got, "node ok:acme:q3-scope must survive import");
    assert.deepEqual(got.scopes, ["system:acme:tenant-svc", "system:acme:billing"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("importer ignores decorative body and links frontmatter", () => {
  const content = [
    "---",
    'id: "x:1"',
    'type: "Decision"',
    'title: "T"',
    "graph_edges: []",
    "links:",
    "  refines:",
    '    - "[[Decision/foo|Foo]]"',
    "---",
    "",
    "> 生成物 — 直接編集しない。",
    "",
    "# 見出し",
    "",
    "## 関係",
    "",
    "- refines → [[Decision/foo|Foo]]",
    "",
    "## 説明",
    "",
    "<!-- graphrag:description:begin -->",
    "本当の説明",
    "<!-- graphrag:description:end -->",
    ""
  ].join("\n");
  const { node, edges } = importVaultFile(content);
  assert.deepEqual(node, {
    id: "x:1",
    type: "Decision",
    title: "T",
    description: "本当の説明"
  });
  assert.equal(edges.length, 0);
});

test("per-node generated_at round-trips via banner and stays out of frontmatter (anti-churn)", () => {
  // DIFFERENT nodes carry DIFFERENT generated_at. After import → rebuild, the
  // banner timestamp must come back verbatim so unchanged nodes regenerate to
  // BYTE-IDENTICAL files (the delta writer then skips them).
  const graph = {
    nodes: [
      {
        id: "decision:a",
        type: "Decision",
        title: "A",
        summary: "sa",
        generated_at: "2026-05-30T00:00:00.000Z"
      },
      {
        id: "risk:b",
        type: "Risk",
        title: "B",
        summary: "sb",
        generated_at: "2026-05-31T09:00:00.000Z"
      }
    ],
    edges: []
  };
  const files1 = buildVaultFiles(graph);

  // generated_at must NOT appear as a frontmatter line (banner-only field).
  for (const f of files1) {
    assert.ok(
      !/\ngenerated_at:/.test(f.content),
      `${f.relPath}: generated_at must not be a frontmatter line`
    );
    // Banner still carries the per-node timestamp.
  }
  const fileA = files1.find((f) => f.relPath.startsWith("Decision/"))!;
  const fileB = files1.find((f) => f.relPath.startsWith("Risk/"))!;
  assert.ok(fileA.content.includes("source snapshot: 2026-05-30T00:00:00.000Z"));
  assert.ok(fileB.content.includes("source snapshot: 2026-05-31T09:00:00.000Z"));

  const dir = writeVault(files1);
  try {
    const out = importVault(dir);
    const byId = canonicalize(out).nodes;
    assert.strictEqual(byId.get("decision:a")!.generated_at, "2026-05-30T00:00:00.000Z");
    assert.strictEqual(byId.get("risk:b")!.generated_at, "2026-05-31T09:00:00.000Z");

    // Rebuild from the imported graph → byte-identical to the first generation.
    const files2 = buildVaultFiles(out);
    const map1 = new Map(files1.map((f) => [f.relPath, f.content]));
    const map2 = new Map(files2.map((f) => [f.relPath, f.content]));
    assert.equal(map2.size, map1.size, "file count");
    for (const [rel, content] of map1) {
      assert.equal(map2.get(rel), content, `content drift in ${rel}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeVaultDelta writes nothing when the graph round-trips identically (no churn)", () => {
  const graph = {
    nodes: [
      { id: "decision:a", type: "Decision", title: "A", summary: "sa",
        generated_at: "2026-05-30T00:00:00.000Z" },
      { id: "risk:b", type: "Risk", title: "B", summary: "sb",
        generated_at: "2026-05-31T09:00:00.000Z" },
      { id: "file:c", type: "File", title: "c.ts",
        generated_at: "2026-05-28T12:34:56.000Z" }
    ],
    edges: [
      { id: "e:1", type: "addresses", from: "decision:a", to: "risk:b" }
    ]
  };
  const dir = writeVault(buildVaultFiles(graph));
  try {
    const imported = importVault(dir);
    const res = writeVaultDelta(dir, imported);
    assert.deepEqual(res.written, [], `expected no rewrites, got ${JSON.stringify(res.written)}`);
    assert.deepEqual(res.removed, [], `expected no removals, got ${JSON.stringify(res.removed)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("undefined-valued field does not round-trip as null (build-vault skips it)", () => {
  const graph = {
    generated_at: "2026-05-29T00:00:00.000Z",
    nodes: [{ id: "file:x", type: "File", title: "x", display: undefined }],
    edges: []
  };
  const files = buildVaultFiles(graph);
  const dir = writeVault(files);
  try {
    const out = importVault(dir);
    const got = canonicalize(out).nodes.get("file:x");
    // undefined のフィールドは書かれず、null として復活しない
    assert.strictEqual(got.display, undefined, `display must not become null (got ${JSON.stringify(got.display)})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Windows / git autocrlf 耐性 -------------------------------------------
// build-vault は LF で書くが、core.autocrlf=true の git は Windows チェックアウトで
// CRLF に変換する。パーサが LF 専用だと vault 全体が "missing frontmatter open fence"
// で読めなくなる。読みは CRLF を許容し、書き戻し(churn 判定)は EOL 差を無視する。

test("importVaultFile は CRLF チェックアウト(Windows autocrlf)を LF と同一に解釈する", () => {
  const files = buildVaultFiles({
    generated_at: "2026-01-01T00:00:00.000Z",
    nodes: [{ id: "decision:s:a", type: "Decision", title: "A", summary: "a", description: "なぜ a なのか" }],
    edges: [],
  });
  const nodeFile = files.find((f) => f.relPath.includes("Decision"));
  assert.ok(nodeFile, "前提: Decision ファイルが生成される");
  const lf = nodeFile!.content;
  const crlf = lf.replace(/\n/g, "\r\n");
  const fromLf = importVaultFile(lf);
  const fromCrlf = importVaultFile(crlf);
  assert.deepEqual(fromCrlf.node, fromLf.node, "CRLF は LF と同じ node に解釈される");
  assert.deepEqual(fromCrlf.edges, fromLf.edges, "CRLF は LF と同じ edges に解釈される");
});

test("writeVaultDelta は CRLF と LF の差だけでは churn しない (autocrlf 耐性)", () => {
  const graph = {
    generated_at: "2026-01-01T00:00:00.000Z",
    nodes: [
      { id: "system:s", type: "System", title: "S" },
      { id: "decision:s:a", type: "Decision", title: "A", summary: "a" },
    ],
    edges: [],
  };
  // git autocrlf チェックアウト相当: 既存ファイルを CRLF で置く。
  const dir = writeVault(
    buildVaultFiles(graph).map((f) => ({ relPath: f.relPath, content: f.content.replace(/\n/g, "\r\n") }))
  );
  try {
    const res = writeVaultDelta(dir, graph);
    assert.deepEqual(res.written, [], "EOL 差だけのファイルは書き直さない (全書き直し churn を防ぐ)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
