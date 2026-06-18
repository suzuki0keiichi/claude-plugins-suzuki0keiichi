import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { normalizeVault } from "./normalize-vault.ts";
import { buildVaultFiles } from "./build-vault.ts";
import { importVault } from "./import-vault.ts";

const TMP = path.join(import.meta.dirname ?? ".", ".test-normalize-vault");

function setup() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

function writeVault(dir: string, graph: any) {
  const files = buildVaultFiles(graph);
  for (const f of files) {
    const abs = path.join(dir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
}

describe("normalize-vault", () => {
  test("rewrites alias types and id prefixes to canonical", () => {
    setup();
    const vault = path.join(TMP, "vault");
    // 旧 canonical (Vein/Pocket/Stratum) で vault を構築
    writeVault(vault, {
      nodes: [
        { id: "vein:s:auth", type: "Vein", title: "認証", summary: "横断" },
        { id: "pocket:s:core", type: "Pocket", title: "中核", summary: "コア" },
        { id: "stratum:s:base", type: "Stratum", title: "基盤", summary: "基盤層" },
        { id: "file:s:a.ts", type: "File", title: "a.ts", summary: "source", path: "a.ts" },
      ],
      edges: [
        { id: "edge:evidenced_by:vein_s_auth->file_s_a.ts", type: "evidenced_by", from: "vein:s:auth", to: "file:s:a.ts" }
      ]
    });

    const result = normalizeVault(vault, { git: false });
    assert.equal(result.nodesRetyped, 3);
    assert.equal(result.idsRewritten, 3);
    assert.ok(result.filesWritten > 0);

    // 再読み込みして確認
    const graph = importVault(vault);
    const nodeById = new Map(graph.nodes.map((n: any) => [n.id, n]));
    assert.ok(nodeById.has("concern:s:auth"), "vein: → concern:");
    assert.equal(nodeById.get("concern:s:auth").type, "Concern");
    assert.ok(nodeById.has("component:s:core"), "pocket: → component:");
    assert.equal(nodeById.get("component:s:core").type, "Component");
    assert.ok(nodeById.has("layer:s:base"), "stratum: → layer:");
    assert.equal(nodeById.get("layer:s:base").type, "Layer");

    // エッジの from/to も正規化されている
    const edge = graph.edges.find((e: any) => e.type === "evidenced_by" && e.from === "concern:s:auth");
    assert.ok(edge, "edge from rewritten to concern:s:auth");

    rmSync(TMP, { recursive: true, force: true });
  });

  test("idempotent — already canonical vault is unchanged", () => {
    setup();
    const vault = path.join(TMP, "vault-canonical");
    writeVault(vault, {
      nodes: [
        { id: "concern:s:auth", type: "Concern", title: "認証", summary: "横断" },
        { id: "component:s:core", type: "Component", title: "中核", summary: "コア" },
      ],
      edges: []
    });

    const result = normalizeVault(vault, { git: false });
    assert.equal(result.nodesRetyped, 0);
    assert.equal(result.idsRewritten, 0);

    rmSync(TMP, { recursive: true, force: true });
  });

  test("dry-run does not write files", () => {
    setup();
    const vault = path.join(TMP, "vault-dry");
    writeVault(vault, {
      nodes: [
        { id: "vein:s:auth", type: "Vein", title: "認証", summary: "横断" },
      ],
      edges: []
    });

    const result = normalizeVault(vault, { dryRun: true, git: false });
    assert.equal(result.nodesRetyped, 1);
    assert.equal(result.idsRewritten, 1);
    assert.equal(result.filesWritten, 0);

    // vault はまだ旧名のまま
    const graph = importVault(vault);
    assert.equal(graph.nodes[0].type, "Vein");

    rmSync(TMP, { recursive: true, force: true });
  });

  test("old vault folders are cleaned up after normalization", () => {
    setup();
    const vault = path.join(TMP, "vault-folders");
    writeVault(vault, {
      nodes: [
        { id: "vein:s:auth", type: "Vein", title: "認証", summary: "横断" },
      ],
      edges: []
    });
    // Vein/ フォルダが存在する
    assert.ok(existsSync(path.join(vault, "Vein")));

    normalizeVault(vault, { git: false });

    // Concern/ に移動し、Vein/ は空なので pruned
    assert.ok(existsSync(path.join(vault, "Concern")), "Concern/ created");
    assert.ok(!existsSync(path.join(vault, "Vein")), "Vein/ pruned");

    rmSync(TMP, { recursive: true, force: true });
  });
});
