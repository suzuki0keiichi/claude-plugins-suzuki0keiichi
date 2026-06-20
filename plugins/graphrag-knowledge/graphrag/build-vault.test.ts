import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildVaultFiles, slugifyTitle, nodesLostByOverwrite, main } from "./build-vault.ts";
import { importVaultFile } from "./import-vault.ts";

// Mirror importVault's in-memory reconstruction (file-path sorted, edge-deduped)
// without touching disk, so we can assert the import->build round-trip property.
function reimport(files: { relPath: string; content: string }[]) {
  const sorted = [...files].sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0
  );
  const nodes: any[] = [];
  const edges: any[] = [];
  const seen = new Set<string>();
  for (const f of sorted) {
    const { node, edges: es } = importVaultFile(f.content);
    nodes.push(node);
    for (const e of es) {
      const id = typeof e.id === "string" ? e.id : JSON.stringify(e);
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push(e);
    }
  }
  return { nodes, edges };
}

function sampleGraph() {
  return {
    generated_at: "2026-05-17T00:00:00.000Z",
    nodes: [
      {
        id: "decision:graphrag:short-label-source",
        type: "Decision",
        title:
          "非常に長い正本タイトル これはファイル名や本文H1の元にはならないはず スラグは短ラベルから導出する",
        summary: "要約テキスト",
        description: "これは説明本文。frontmatter には出さない。",
        raw_content: "逐語の一次情報ログ RAWLOGBODYONLY",
        raw_content_status: "source",
        display: { ja: { short_label: "短ラベル決定" } }
      },
      {
        id: "risk:graphrag:no-raw",
        type: "Risk",
        title: "リスクのタイトル",
        summary: "リスク要約のみ"
      }
    ],
    edges: [
      {
        from: "decision:graphrag:short-label-source",
        to: "risk:graphrag:no-raw",
        type: "addresses"
      }
    ]
  };
}

test("buildVaultFiles emits exactly one file per node", () => {
  const graph = sampleGraph();
  const files = buildVaultFiles(graph);
  assert.equal(files.length, graph.nodes.length);
});

test("frontmatter excludes description and raw_content (they live in the body)", () => {
  const files = buildVaultFiles(sampleGraph());
  const decision = files.find((f) => f.relPath.startsWith("Decision/"))!;
  const fm = decision.content.slice(
    decision.content.indexOf("---") + 3,
    decision.content.indexOf("\n---\n")
  );
  assert.ok(!/^description:/m.test(fm));
  assert.ok(!/^raw_content:/m.test(fm));
  assert.ok(!fm.includes("これは説明本文"));
  assert.ok(!fm.includes("RAWLOGBODYONLY"));
  // Full title still belongs to frontmatter.
  assert.ok(fm.includes("非常に長い正本タイトル"));
});

test("body carries description section with strict round-trip markers", () => {
  const files = buildVaultFiles(sampleGraph());
  const decision = files.find((f) => f.relPath.startsWith("Decision/"))!;
  assert.ok(decision.content.includes("## 説明"));
  assert.ok(decision.content.includes("<!-- graphrag:description:begin -->"));
  assert.ok(decision.content.includes("これは説明本文。frontmatter には出さない。"));
  assert.ok(decision.content.includes("<!-- graphrag:description:end -->"));
});

test("no `## 説明` heading when the node has no description (summary stays in frontmatter)", () => {
  const files = buildVaultFiles(sampleGraph());
  const risk = files.find((f) => f.relPath.startsWith("Risk/"))!;
  // description が無いので body に `## 説明` は出ない (summary 丸写しを避ける)。
  assert.ok(!risk.content.includes("## 説明"), "description-less node must not emit a 説明 section");
  // summary 本文が body に重複出力されていない。
  assert.ok(!risk.content.includes("リスク要約のみ\n\n##"), "summary must not be duplicated into the body");
  // ただし summary は frontmatter に残る (読者から消えない)。
  const fm = risk.content.slice(risk.content.indexOf("---") + 3, risk.content.indexOf("\n---\n"));
  assert.ok(/^summary:/m.test(fm) && fm.includes("リスク要約のみ"), "summary remains in frontmatter");
});

test("body carries raw_content section only when raw_content is present", () => {
  const files = buildVaultFiles(sampleGraph());
  const decision = files.find((f) => f.relPath.startsWith("Decision/"))!;
  assert.ok(decision.content.includes("## 一次情報"));
  assert.ok(decision.content.includes("<!-- graphrag:raw_content:begin -->"));
  assert.ok(decision.content.includes("逐語の一次情報ログ RAWLOGBODYONLY"));
  assert.ok(decision.content.includes("<!-- graphrag:raw_content:end -->"));

  const risk = files.find((f) => f.relPath.startsWith("Risk/"))!;
  assert.ok(!risk.content.includes("## 一次情報"));
  assert.ok(!risk.content.includes("graphrag:raw_content:begin"));
});

test("filename slug and body H1 derive from short label, not the long title", () => {
  const files = buildVaultFiles(sampleGraph());
  const decision = files.find((f) => f.relPath.startsWith("Decision/"))!;

  const expectedSlug = slugifyTitle("短ラベル決定", "decision:graphrag:short-label-source");
  assert.equal(decision.relPath, `Decision/${expectedSlug}.md`);
  assert.ok(decision.content.includes(`# 短ラベル決定`));
  // The long canonical title is not used as the H1.
  assert.ok(!decision.content.includes("# 非常に長い正本タイトル"));
});

test("relationship links resolve to existing Type/base files (no dangling links)", () => {
  const files = buildVaultFiles(sampleGraph());
  const byPath = new Map(files.map((f) => [f.relPath, f]));
  const linkRe = /\[\[([^\]|]+)\|/g;
  for (const file of files) {
    for (const match of file.content.matchAll(linkRe)) {
      const target = match[1];
      assert.ok(
        byPath.has(`${target}.md`),
        `dangling link ${target} in ${file.relPath}`
      );
    }
  }
  const decision = files.find((f) => f.relPath.startsWith("Decision/"))!;
  assert.ok(decision.content.includes("[[Risk/"));
});

// Two nodes whose short labels slugify to the same base ("index.ts") must get a
// deterministic, identity-pinned filename. The collision suffix (`-2`) is assigned
// in node-id order, NOT input order, so importVault's file-path ordering can never
// swap which node owns the base name. Regression for the round-trip churn /
// duplicate-id corruption found on real vaults (ichibaya index.ts / index.ts-2).
function collisionGraph() {
  return {
    nodes: [
      // Intentionally NOT in id order; the larger id appears first.
      {
        id: "file:proj:packages/shared/src/index.ts",
        type: "File",
        title: "index.ts",
        path: "packages/shared/src/index.ts",
        generated_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "file:proj:apps/server/src/index.ts",
        type: "File",
        title: "index.ts",
        path: "apps/server/src/index.ts",
        generated_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    edges: [],
  };
}

test("collision suffix is pinned to node id, independent of input array order", () => {
  const g = collisionGraph();
  const filesA = buildVaultFiles(g);
  // Same node set, reversed array order, must yield the identical mapping.
  const filesB = buildVaultFiles({ ...g, nodes: [...g.nodes].reverse() });
  const idOf = (files: { relPath: string; content: string }[], rel: string) =>
    /^id: "([^"]+)"/m.exec(files.find((f) => f.relPath === rel)!.content)![1];
  assert.equal(idOf(filesA, "File/index.ts.md"), "file:proj:apps/server/src/index.ts");
  assert.equal(idOf(filesB, "File/index.ts.md"), "file:proj:apps/server/src/index.ts");
  assert.equal(idOf(filesA, "File/index.ts-2.md"), "file:proj:packages/shared/src/index.ts");
});

test("import -> build is idempotent for slug-colliding nodes (no period-2 churn)", () => {
  const round1 = buildVaultFiles(collisionGraph());
  const round2 = buildVaultFiles(reimport(round1));
  const m1 = new Map(round1.map((f) => [f.relPath, f.content]));
  const m2 = new Map(round2.map((f) => [f.relPath, f.content]));
  assert.equal(m2.size, m1.size);
  for (const [rel, content] of m1) {
    assert.equal(m2.get(rel), content, `round-trip changed ${rel}`);
  }
});

// --- 上書きガード: vault-build が既存知識を全消ししないことを保証する ---

test("nodesLostByOverwrite flags nodes present in the vault but absent from the source graph", () => {
  const existing = {
    nodes: [
      { id: "file:proj:src/a.ts", type: "File" },
      { id: "decision:proj:keep-x", type: "Decision" },
      { id: "ok:proj:do-y", type: "OK" },
    ],
  };
  // 索引出力は File しか持たない。
  const source = { nodes: [{ id: "file:proj:src/a.ts", type: "File" }] };
  const lost = nodesLostByOverwrite(existing, source);
  assert.deepEqual(
    lost.map((n) => n.id).sort(),
    ["decision:proj:keep-x", "ok:proj:do-y"]
  );
});

test("nodesLostByOverwrite is empty when the source graph is a superset (safe re-index)", () => {
  const existing = { nodes: [{ id: "file:proj:src/a.ts", type: "File" }] };
  const source = {
    nodes: [
      { id: "file:proj:src/a.ts", type: "File" },
      { id: "file:proj:src/b.ts", type: "File" },
    ],
  };
  assert.deepEqual(nodesLostByOverwrite(existing, source), []);
});

test("nodesLostByOverwrite is empty for an empty existing vault (initial build)", () => {
  assert.deepEqual(nodesLostByOverwrite({ nodes: [] }, { nodes: [{ id: "x" }] }), []);
  assert.deepEqual(nodesLostByOverwrite({}, { nodes: [{ id: "x" }] }), []);
});

// main() を実ディスクで叩く統合テスト。process.exit を捕えて検証する。
function runMain(argv: string[]): { exitCode: number | null } {
  const realExit = process.exit;
  let exitCode: number | null = null;
  // @ts-expect-error テスト用に exit を差し替える
  process.exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error("__exit__");
  };
  try {
    main(argv);
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "__exit__") throw err;
  } finally {
    process.exit = realExit;
  }
  return { exitCode };
}

function writeGraphJson(dir: string, graph: unknown): string {
  const p = path.join(dir, "graph.json");
  writeFileSync(p, JSON.stringify(graph));
  return p;
}

test("main refuses to overwrite a vault holding nodes absent from the source graph", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "graphrag-build-"));
  try {
    // 既存 vault: 索引出力 (File) + 手書きの知識ノード (Decision)。
    const graphPath = writeGraphJson(tmp, {
      nodes: [{ id: "file:proj:src/a.ts", type: "File", title: "a.ts", path: "src/a.ts" }],
    });
    const vaultDir = path.join(tmp, "vault");
    main([graphPath, vaultDir]); // 初回構築 (空) は通る
    // 手で Decision を足す。
    mkdirSync(path.join(vaultDir, "Decision"), { recursive: true });
    writeFileSync(
      path.join(vaultDir, "Decision", "keep-x.md"),
      "---\nid: \"decision:proj:keep-x\"\ntype: \"Decision\"\ntitle: \"Keep X\"\ngraph_edges: []\nlinks: {}\n---\n\n# Keep X\n"
    );

    // 同じ索引 (File のみ) で再 build → Decision が失われるので拒否。
    const { exitCode } = runMain([graphPath, vaultDir]);
    assert.equal(exitCode, 1, "should refuse with exit 1");
    // Decision ファイルは消えずに残っている。
    assert.ok(existsSync(path.join(vaultDir, "Decision", "keep-x.md")), "knowledge node must survive");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("main --force overwrites even when knowledge nodes would be lost", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "graphrag-build-"));
  try {
    const graphPath = writeGraphJson(tmp, {
      nodes: [{ id: "file:proj:src/a.ts", type: "File", title: "a.ts", path: "src/a.ts" }],
    });
    const vaultDir = path.join(tmp, "vault");
    main([graphPath, vaultDir]);
    mkdirSync(path.join(vaultDir, "Decision"), { recursive: true });
    writeFileSync(
      path.join(vaultDir, "Decision", "keep-x.md"),
      "---\nid: \"decision:proj:keep-x\"\ntype: \"Decision\"\ntitle: \"Keep X\"\ngraph_edges: []\nlinks: {}\n---\n\n# Keep X\n"
    );

    const { exitCode } = runMain([graphPath, vaultDir, "--force"]);
    assert.equal(exitCode, null, "--force should not exit early");
    // 全消し→再構築されたので Decision は消える (--force は明示同意)。
    assert.ok(!existsSync(path.join(vaultDir, "Decision")), "force rebuild drops non-indexed nodes");
    assert.ok(existsSync(path.join(vaultDir, "File")), "indexed nodes are rebuilt");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("main allows initial build on an empty/absent vault directory", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "graphrag-build-"));
  try {
    const graphPath = writeGraphJson(tmp, {
      nodes: [{ id: "file:proj:src/a.ts", type: "File", title: "a.ts", path: "src/a.ts" }],
    });
    const vaultDir = path.join(tmp, "vault");
    const { exitCode } = runMain([graphPath, vaultDir]);
    assert.equal(exitCode, null, "initial build must not be blocked");
    assert.ok(readdirSync(vaultDir).length > 0, "vault was written");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
