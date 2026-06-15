import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { indexCodebase, main } from "./index-codebase.ts";
import { validateGraph } from "./schema.ts";
import { buildVaultFiles } from "./build-vault.ts";

function makeRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "idx-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "src", "pkg"), { recursive: true });
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "src", "pkg", "package.json"), `{"name":"pkg"}`);
  writeFileSync(
    path.join(root, "src", "pkg", "core.ts"),
    `import { z } from "zod";\nexport function doThing(a: number) { return a + 1; }\nexport class Engine {}\nfunction helper() {}\n`
  );
  writeFileSync(path.join(root, "src", "pkg", "core.test.ts"), `import { doThing } from "./core.ts";\ntest("x", () => doThing(1));\n`);
  writeFileSync(path.join(root, "src", "util.py"), `import os\ndef public_fn():\n    return 1\ndef _private():\n    return 2\n`);
  writeFileSync(path.join(root, "docs", "guide.md"), `# Guide\n## Setup\nsome text\n`);
  // A small internal dependency cluster (chain a->b->c->d) so a dependency
  // community + topology bands form.
  mkdirSync(path.join(root, "src", "mod"), { recursive: true });
  writeFileSync(path.join(root, "src", "mod", "a.ts"), `import { b } from "./b.ts";\nexport const a = () => b();\n`);
  writeFileSync(path.join(root, "src", "mod", "b.ts"), `import { c } from "./c.ts";\nexport const b = () => c();\n`);
  writeFileSync(path.join(root, "src", "mod", "c.ts"), `import { d } from "./d.ts";\nexport const c = () => d();\n`);
  writeFileSync(path.join(root, "src", "mod", "d.ts"), `export const d = () => 1;\n`);
  return root;
}

test("indexCodebase produces a schema-valid graph with rich File summaries", () => {
  const root = makeRepo();
  try {
    const graph = indexCodebase({ root, systemName: "demo" });
    assert.deepEqual(validateGraph(graph), [], "indexed graph must pass schema validation");

    // v3.3: System root と contains は生成しない (vault=scope)
    assert.ok(!graph.nodes.some((n: any) => n.type === "System"), "no System node");

    const core = graph.nodes.find((n: any) => n.type === "File" && n.path.endsWith("core.ts"));
    assert.ok(core, "core.ts File node present");
    assert.ok(core.summary.includes("主要API") && core.summary.includes("doThing"), `summary carries exported API: ${core.summary}`);
    assert.ok(core.summary.includes("依存先") && core.summary.includes("zod"), `summary carries imports: ${core.summary}`);
    assert.deepEqual(core.exported_symbols.sort(), ["Engine", "doThing"]);
    // 機械テンプレ要約は provisional。LLM がファイルを読んで本物に書き換えるまで未完を自己申告する。
    assert.equal(core.summary_provisional, true, "template File summary is flagged provisional");

    const py = graph.nodes.find((n: any) => n.type === "File" && n.path.endsWith("util.py"));
    assert.ok(py.exported_symbols.includes("public_fn") && !py.exported_symbols.includes("_private"), "python public/private split");

    const md = graph.nodes.find((n: any) => n.type === "File" && n.path.endsWith("guide.md"));
    assert.equal(md.role, "documentation");
    assert.ok(md.summary.includes("見出し") && md.summary.includes("Setup"), "markdown headings in summary");

    const testFile = graph.nodes.find((n: any) => n.type === "File" && n.path.endsWith("core.test.ts"));
    assert.equal(testFile.role, "test");

    assert.ok(!graph.edges.some((e: any) => e.type === "contains"), "no contains edges");

    // Pocket (旧 Component) = dependency community (graph distance), candidate for LLM naming.
    // indexer は canonical 地質名を吐く (SKILL「新規は地質名で書く」)。
    const component = graph.nodes.find((n: any) => n.type === "Pocket" && n.candidate === true);
    assert.ok(component, "dependency-community Pocket candidate present");
    assert.equal(component.signals?.kind, "dependency-community");
    assert.ok(component.judgment_input?.member_files?.length >= 3, "Pocket carries >=3 member files for LLM judgment");
    assert.equal(component.summary_provisional, true, "Pocket candidate summary (構成要素サマリ) is flagged provisional");
    assert.ok(graph.edges.some((e: any) => e.type === "evidenced_by" && e.from === component.id), "Pocket evidenced_by File edges");
    assert.ok(component.id.startsWith("pocket:"), "Pocket id uses canonical pocket: prefix");
    // The a->b->c->d chain should land in one community.
    const memberPaths = new Set(component.judgment_input.member_files);
    assert.ok(["src/mod/a.ts", "src/mod/b.ts", "src/mod/c.ts"].every((p) => memberPaths.has(p)),
      `import chain clustered together: ${[...memberPaths].join(",")}`);

    // Stratum (旧 Layer) = dependency-topology band (graph topology), candidate for LLM naming.
    const layer = graph.nodes.find((n: any) => n.type === "Stratum" && n.candidate === true);
    assert.ok(layer, "dependency-topology Stratum candidate present");
    assert.equal(layer.signals?.kind, "dependency-topology-band");
    assert.ok(typeof layer.signals?.depth_band === "number", "Stratum carries a depth band");
    assert.ok(layer.id.startsWith("stratum:"), "Stratum id uses canonical stratum: prefix");
    assert.equal(layer.summary_provisional, true, "Stratum candidate summary (構成要素サマリ) is flagged provisional");

    assert.ok(graph.nodes.filter((n: any) => n.type === "File").every((n: any) => n.change_status === "new"), "all new on first index");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("indexCodebase incremental: unchanged + deleted detection", () => {
  const root = makeRepo();
  try {
    const first = indexCodebase({ root, systemName: "demo" });
    // Re-index against previous; nothing changed on disk.
    const second = indexCodebase({ root, systemName: "demo", previous: first });
    assert.ok(
      second.nodes.filter((n: any) => n.type === "File").every((n: any) => n.change_status === "unchanged"),
      "re-index of untouched repo marks files unchanged"
    );
    // Simulate deletion: previous had an extra File node not on disk now.
    const withGhost = { ...first, nodes: [...first.nodes, { id: "file:demo:ghost", type: "File", path: "ghost.ts", content_hash: "x" }] };
    const third = indexCodebase({ root, systemName: "demo", previous: withGhost });
    assert.ok(third.stale_candidates.deleted_files.includes("file:demo:ghost"), "deleted file surfaced as stale candidate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 回帰: 前回 summary を「本物として継ぐ」のは trustPreviousSummaries=true (= 正本 vault が
// source) のときだけ。scaffold を渡したとき (trust=false) は summary を信用せず作り直して
// provisional を立てる。これが無いと、機械テンプレ summary が「フラグ無し=本物」と誤認され
// 再 author 済み要約を作り直しで握り潰す穴になる。
test("summary reuse is gated on trustPreviousSummaries (vault のみ信用)", () => {
  const root = makeRepo();
  try {
    const first = indexCodebase({ root, systemName: "demo" });
    const coreId = first.nodes.find((n: any) => n.type === "File" && n.path.endsWith("core.ts")).id;
    // 「authored な previous」を模す: core.ts の summary を本物の意味に書き換え provisional を外す。
    const authored = {
      ...first,
      nodes: first.nodes.map((n: any) =>
        n.id === coreId ? { ...n, summary: "本物の意味要約: ドメイン計算の中核", summary_provisional: undefined } : n
      ),
    };

    // trust=true (vault 相当): 本物要約を継ぎ provisional は立たない。
    const trusted = indexCodebase({ root, systemName: "demo", previous: authored, trustPreviousSummaries: true });
    const coreTrusted = trusted.nodes.find((n: any) => n.id === coreId);
    assert.equal(coreTrusted.summary, "本物の意味要約: ドメイン計算の中核", "vault source: authored summary is reused");
    assert.notEqual(coreTrusted.summary_provisional, true, "reused authored summary is not flagged provisional");

    // trust=false (scaffold 相当): 同じ previous でも summary を信用せず作り直し provisional を立てる。
    const untrusted = indexCodebase({ root, systemName: "demo", previous: authored, trustPreviousSummaries: false });
    const coreUntrusted = untrusted.nodes.find((n: any) => n.id === coreId);
    assert.notEqual(coreUntrusted.summary, "本物の意味要約: ドメイン計算の中核", "scaffold source: summary is NOT trusted (regenerated)");
    assert.equal(coreUntrusted.summary_provisional, true, "regenerated template summary is flagged provisional");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 回帰 (end-to-end, ichibaya 相当): 再 index で previous ソースとして vault を優先する。
// vault に本物 summary が在れば、スタブ scaffold を --previous で渡しても vault が勝ち、
// 本物要約が継がれて provisional にならない。
test("main: --vault が --previous(スタブ) より優先され本物要約を継ぐ", async () => {
  const root = makeRepo();
  const savedEnv = process.env.GRAPHRAG_VAULT_DIR;
  delete process.env.GRAPHRAG_VAULT_DIR; // テスト環境の env 干渉を排除
  try {
    const first = indexCodebase({ root, systemName: "demo" });
    const coreId = first.nodes.find((n: any) => n.type === "File" && n.path.endsWith("core.ts")).id;

    // vault を作る: core.ts に本物 summary、provisional は外す。
    const vaultGraph = {
      ...first,
      nodes: first.nodes.map((n: any) =>
        n.id === coreId ? { ...n, summary: "本物: 中核計算ロジック", summary_provisional: undefined } : n
      ),
    };
    const vaultDir = path.join(root, ".graphrag", "vault");
    for (const f of buildVaultFiles(vaultGraph)) {
      const abs = path.join(vaultDir, f.relPath);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
    }

    // スタブ scaffold を --previous に置く(footgun): core.ts はテンプレ要約・provisional 無し。
    const stubPath = path.join(root, ".graphrag", "stub.json");
    writeFileSync(stubPath, JSON.stringify(first)); // first = テンプレ summary + provisional:true

    const outPath = path.join(root, ".graphrag", "out.json");
    await main(["--root", root, "--system", "demo", "--vault", vaultDir, "--previous", stubPath, "--out", outPath]);

    const out = JSON.parse(readFileSync(outPath, "utf8"));
    const core = out.nodes.find((n: any) => n.id === coreId);
    assert.equal(core.summary, "本物: 中核計算ロジック", "vault が --previous より優先され本物要約を継ぐ");
    assert.notEqual(core.summary_provisional, true, "継いだ本物要約は provisional でない");
  } finally {
    if (savedEnv === undefined) delete process.env.GRAPHRAG_VAULT_DIR;
    else process.env.GRAPHRAG_VAULT_DIR = savedEnv;
    rmSync(root, { recursive: true, force: true });
  }
});
