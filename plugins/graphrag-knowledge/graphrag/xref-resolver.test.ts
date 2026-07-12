import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseCrossVaultRef,
  parseVaultSlug,
  parseVaultSlugAliases,
  parseVaultParent,
  findVaultBySlug,
  findVaultBySlugWithInfo,
  resolveCrossVaultRef,
  checkCrossVaultRefs,
  checkVaultParent,
  augmentMatchesWithXRefResolutions,
  type XRefCheckResult
} from "./xref-resolver.ts";
import { buildVaultFiles } from "./build-vault.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal vault on disk with VAULT.md + one Deliverable node. */
function makeVault(opts: {
  root: string;
  repoName: string;
  slug: string;
  aliases?: string[];
  schema?: string;
  parent?: string;
  node: { id: string; type: string; title: string; summary: string };
}): { vaultDir: string } {
  const repoDir = path.join(opts.root, opts.repoName);
  const vaultDir = path.join(repoDir, "vault");
  mkdirSync(vaultDir, { recursive: true });

  const aliasesYaml =
    opts.aliases && opts.aliases.length > 0
      ? `vault_slug_aliases:\n${opts.aliases.map((a) => `  - ${a}`).join("\n")}\n`
      : "";
  const schema = opts.schema ?? "system";
  const parentYaml = opts.parent ? `parent: ${opts.parent}\n` : "";

  // VAULT.md (sibling of vault/)
  writeFileSync(
    path.join(repoDir, "VAULT.md"),
    `---\nname: ${opts.repoName}\nschema: ${schema}\nvault_slug: ${opts.slug}\n${parentYaml}${aliasesYaml}---\nA test vault.\n`
  );

  // Write node file via buildVaultFiles to get proper import-compatible format
  const graph = {
    nodes: [opts.node],
    edges: []
  };
  const files = buildVaultFiles(graph);
  for (const f of files) {
    const abs = path.join(vaultDir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }

  return { vaultDir };
}

/** Create a worldDir that is just a parent directory of multiple repo dirs. */
function makeWorldDir(root: string): string {
  const worldDir = path.join(root, "world");
  mkdirSync(worldDir, { recursive: true });
  return worldDir;
}

// ---------------------------------------------------------------------------
// parseCrossVaultRef
// ---------------------------------------------------------------------------

test("parseCrossVaultRef: parses standard vault ref", () => {
  const parts = parseCrossVaultRef("vault:billing/deliverable:billing:v2-release");
  assert.ok(parts !== null);
  assert.equal(parts!.vaultSlug, "billing");
  assert.equal(parts!.nodeId, "deliverable:billing:v2-release");
});

test("parseCrossVaultRef: parses ref with colons in nodeId", () => {
  const parts = parseCrossVaultRef("vault:my-slug/goal:project-x:some-goal");
  assert.ok(parts !== null);
  assert.equal(parts!.vaultSlug, "my-slug");
  assert.equal(parts!.nodeId, "goal:project-x:some-goal");
});

test("parseCrossVaultRef: returns null for local node id", () => {
  assert.equal(parseCrossVaultRef("decision:some:local-node"), null);
  assert.equal(parseCrossVaultRef("file:x:y"), null);
  assert.equal(parseCrossVaultRef(""), null);
});

test("parseCrossVaultRef: returns null for vault: prefix with no slash", () => {
  assert.equal(parseCrossVaultRef("vault:noslash"), null);
});

test("parseCrossVaultRef: returns null for empty slug or empty nodeId", () => {
  assert.equal(parseCrossVaultRef("vault:/node"), null); // empty slug
  assert.equal(parseCrossVaultRef("vault:slug/"), null); // empty nodeId
});

// ---------------------------------------------------------------------------
// parseVaultSlug
// ---------------------------------------------------------------------------

test("parseVaultSlug: reads vault_slug from frontmatter", () => {
  const content = `---\nname: billing\nschema: system\nvault_slug: billing\n---\nA system vault.\n`;
  assert.equal(parseVaultSlug(content), "billing");
});

test("parseVaultSlug: returns null when vault_slug is absent", () => {
  const content = `---\nname: billing\nschema: system\n---\nA system vault.\n`;
  assert.equal(parseVaultSlug(content), null);
});

test("parseVaultSlug: returns null when there is no frontmatter", () => {
  assert.equal(parseVaultSlug("Just a plain description.\n"), null);
});

test("parseVaultSlug: handles quoted vault_slug values", () => {
  const content = `---\nvault_slug: "my-slug"\n---\n`;
  assert.equal(parseVaultSlug(content), "my-slug");
});

test("parseVaultSlug: handles single-quoted vault_slug values", () => {
  const content = `---\nvault_slug: 'another-slug'\n---\n`;
  assert.equal(parseVaultSlug(content), "another-slug");
});

// ---------------------------------------------------------------------------
// parseVaultSlugAliases
// ---------------------------------------------------------------------------

test("parseVaultSlugAliases: returns empty array when field is absent", () => {
  const content = `---\nname: billing\nvault_slug: billing\n---\nDescription.\n`;
  assert.deepEqual(parseVaultSlugAliases(content), []);
});

test("parseVaultSlugAliases: parses a single alias", () => {
  const content = `---\nvault_slug: billing\nvault_slug_aliases:\n  - billing-old\n---\n`;
  assert.deepEqual(parseVaultSlugAliases(content), ["billing-old"]);
});

test("parseVaultSlugAliases: parses multiple aliases", () => {
  const content = `---\nvault_slug: billing\nvault_slug_aliases:\n  - billing-old\n  - billing-service-legacy\n---\n`;
  assert.deepEqual(parseVaultSlugAliases(content), ["billing-old", "billing-service-legacy"]);
});

test("parseVaultSlugAliases: strips quotes from alias values", () => {
  const content = `---\nvault_slug: billing\nvault_slug_aliases:\n  - "billing-old"\n  - 'old-name'\n---\n`;
  assert.deepEqual(parseVaultSlugAliases(content), ["billing-old", "old-name"]);
});

test("parseVaultSlugAliases: returns empty array when there is no frontmatter", () => {
  assert.deepEqual(parseVaultSlugAliases("Just plain text.\n"), []);
});

// ---------------------------------------------------------------------------
// findVaultBySlug
// ---------------------------------------------------------------------------

test("findVaultBySlug: finds vault in canonical layout (worldDir/repoName/vault/)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-find-"));
  try {
    const worldDir = makeWorldDir(root);
    makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      node: { id: "deliverable:billing:v2", type: "Deliverable", title: "Billing API v2", summary: "Release" }
    });

    const found = findVaultBySlug("billing", worldDir);
    assert.ok(found !== null, "should find the vault");
    assert.ok(found!.endsWith(path.join("billing-repo", "vault")), `expected path ending in billing-repo/vault, got ${found}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findVaultBySlug: returns null when no vault has matching slug", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-find-"));
  try {
    const worldDir = makeWorldDir(root);
    makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      node: { id: "deliverable:billing:v2", type: "Deliverable", title: "Billing API v2", summary: "Release" }
    });

    const found = findVaultBySlug("nonexistent-slug", worldDir);
    assert.equal(found, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findVaultBySlug: returns null when worldDir does not exist", () => {
  const found = findVaultBySlug("billing", "/no/such/dir");
  assert.equal(found, null);
});

test("findVaultBySlug: finds correct vault among multiple", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-find-"));
  try {
    const worldDir = makeWorldDir(root);
    makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      node: { id: "deliverable:billing:v2", type: "Deliverable", title: "Billing API v2", summary: "Billing API release" }
    });
    makeVault({
      root: worldDir,
      repoName: "analytics-repo",
      slug: "analytics",
      node: { id: "deliverable:analytics:v1", type: "Deliverable", title: "Analytics v1", summary: "Analytics release" }
    });

    const billing = findVaultBySlug("billing", worldDir);
    const analytics = findVaultBySlug("analytics", worldDir);
    assert.ok(billing !== null);
    assert.ok(analytics !== null);
    assert.ok(billing!.includes("billing-repo"));
    assert.ok(analytics!.includes("analytics-repo"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resolveCrossVaultRef
// ---------------------------------------------------------------------------

test("resolveCrossVaultRef: resolves an existing cross-vault node", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-resolve-"));
  try {
    const worldDir = makeWorldDir(root);
    makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      node: { id: "deliverable:billing:v2-release", type: "Deliverable", title: "Billing API v2 Release", summary: "The v2 milestone." }
    });

    const ref = "vault:billing/deliverable:billing:v2-release";
    const resolved = resolveCrossVaultRef(ref, worldDir);
    assert.ok(resolved !== null, "should resolve");
    assert.equal(resolved!.ref, ref);
    assert.equal(resolved!.node_id, "deliverable:billing:v2-release");
    assert.equal(resolved!.type, "Deliverable");
    assert.equal(resolved!.title, "Billing API v2 Release");
    assert.equal(resolved!.summary, "The v2 milestone.");
    assert.ok(resolved!.vault_path.includes("billing-repo"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveCrossVaultRef: returns null when vault not found (orphan)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-resolve-"));
  try {
    const worldDir = makeWorldDir(root);
    // no vaults created

    const resolved = resolveCrossVaultRef("vault:billing/deliverable:billing:v2", worldDir);
    assert.equal(resolved, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveCrossVaultRef: returns null when node not in vault (broken ref)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-resolve-"));
  try {
    const worldDir = makeWorldDir(root);
    makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      node: { id: "deliverable:billing:v2-release", type: "Deliverable", title: "Billing API v2", summary: "x" }
    });

    // correct slug, wrong nodeId
    const resolved = resolveCrossVaultRef("vault:billing/deliverable:billing:nonexistent", worldDir);
    assert.equal(resolved, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveCrossVaultRef: returns null when GRAPHRAG_WORLD_DIR not set and no worldDir arg", () => {
  const prev = process.env.GRAPHRAG_WORLD_DIR;
  delete process.env.GRAPHRAG_WORLD_DIR;
  try {
    const resolved = resolveCrossVaultRef("vault:billing/deliverable:billing:v2");
    assert.equal(resolved, null);
  } finally {
    if (prev !== undefined) process.env.GRAPHRAG_WORLD_DIR = prev;
  }
});

test("resolveCrossVaultRef: returns null for non-cross-vault ref", () => {
  const resolved = resolveCrossVaultRef("decision:some:local-node", "/some/world");
  assert.equal(resolved, null);
});

test("resolveCrossVaultRef: uses GRAPHRAG_WORLD_DIR env when worldDir arg not provided", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-resolve-"));
  const prev = process.env.GRAPHRAG_WORLD_DIR;
  try {
    const worldDir = makeWorldDir(root);
    makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      node: { id: "deliverable:billing:v2", type: "Deliverable", title: "Billing API v2", summary: "Release" }
    });

    process.env.GRAPHRAG_WORLD_DIR = worldDir;
    const resolved = resolveCrossVaultRef("vault:billing/deliverable:billing:v2");
    assert.ok(resolved !== null);
    assert.equal(resolved!.title, "Billing API v2");
  } finally {
    if (prev !== undefined) process.env.GRAPHRAG_WORLD_DIR = prev;
    else delete process.env.GRAPHRAG_WORLD_DIR;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// checkCrossVaultRefs
// ---------------------------------------------------------------------------

test("checkCrossVaultRefs: resolved status for found node", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-check-"));
  try {
    const worldDir = makeWorldDir(root);
    makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      node: { id: "deliverable:billing:v2", type: "Deliverable", title: "Billing API v2", summary: "The release." }
    });

    const graph = {
      nodes: [
        { id: "goal:proj:milestone-a", type: "Goal", title: "Milestone A", summary: "x" }
      ],
      edges: [
        { id: "e:1", type: "has_premise", from: "goal:proj:milestone-a", to: "vault:billing/deliverable:billing:v2" }
      ]
    };

    const results = checkCrossVaultRefs(graph, worldDir);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "resolved");
    assert.equal(results[0].edge_id, "e:1");
    assert.equal(results[0].ref, "vault:billing/deliverable:billing:v2");
    assert.ok(results[0].resolved !== undefined);
    assert.equal(results[0].resolved!.title, "Billing API v2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkCrossVaultRefs: orphan status when vault slug not found", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-check-"));
  try {
    const worldDir = makeWorldDir(root);
    // no vaults

    const graph = {
      nodes: [{ id: "goal:proj:a", type: "Goal", title: "A", summary: "x" }],
      edges: [
        { id: "e:1", type: "has_premise", from: "goal:proj:a", to: "vault:missing-slug/deliverable:x:y" }
      ]
    };

    const results = checkCrossVaultRefs(graph, worldDir);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "orphan");
    assert.match(results[0].detail ?? "", /missing-slug/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkCrossVaultRefs: broken status when vault found but node missing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-check-"));
  try {
    const worldDir = makeWorldDir(root);
    makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      node: { id: "deliverable:billing:v2", type: "Deliverable", title: "Billing API v2", summary: "x" }
    });

    const graph = {
      nodes: [{ id: "goal:proj:a", type: "Goal", title: "A", summary: "x" }],
      edges: [
        { id: "e:1", type: "has_premise", from: "goal:proj:a", to: "vault:billing/deliverable:billing:nonexistent" }
      ]
    };

    const results = checkCrossVaultRefs(graph, worldDir);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "broken");
    assert.match(results[0].detail ?? "", /nonexistent/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkCrossVaultRefs: unresolvable when worldDir not set", () => {
  const graph = {
    nodes: [{ id: "goal:proj:a", type: "Goal", title: "A", summary: "x" }],
    edges: [
      { id: "e:1", type: "has_premise", from: "goal:proj:a", to: "vault:billing/deliverable:billing:v2" }
    ]
  };

  // explicitly pass undefined (no worldDir, no env)
  const prev = process.env.GRAPHRAG_WORLD_DIR;
  delete process.env.GRAPHRAG_WORLD_DIR;
  try {
    const results = checkCrossVaultRefs(graph, undefined);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "unresolvable");
    assert.match(results[0].detail ?? "", /GRAPHRAG_WORLD_DIR/);
  } finally {
    if (prev !== undefined) process.env.GRAPHRAG_WORLD_DIR = prev;
  }
});

test("checkCrossVaultRefs: returns empty array when no cross-vault edges", () => {
  const graph = {
    nodes: [
      { id: "decision:x:a", type: "Decision", title: "A", summary: "x" },
      { id: "risk:x:b", type: "Risk", title: "B", summary: "y" }
    ],
    edges: [
      { id: "e:1", type: "reduces_risk", from: "decision:x:a", to: "risk:x:b" }
    ]
  };
  const results = checkCrossVaultRefs(graph, "/some/world");
  assert.equal(results.length, 0);
});

test("checkCrossVaultRefs: multiple cross-vault edges in one graph", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-check-"));
  try {
    const worldDir = makeWorldDir(root);
    makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      node: { id: "deliverable:billing:v2", type: "Deliverable", title: "Billing API v2", summary: "x" }
    });

    const graph = {
      nodes: [{ id: "goal:proj:a", type: "Goal", title: "A", summary: "x" }],
      edges: [
        { id: "e:1", type: "has_premise", from: "goal:proj:a", to: "vault:billing/deliverable:billing:v2" },
        { id: "e:2", type: "has_premise", from: "goal:proj:a", to: "vault:analytics/deliverable:analytics:v1" }
      ]
    };

    const results = checkCrossVaultRefs(graph, worldDir);
    assert.equal(results.length, 2);
    const resolved = results.filter((r) => r.status === "resolved");
    const orphan = results.filter((r) => r.status === "orphan");
    assert.equal(resolved.length, 1);
    assert.equal(orphan.length, 1);
    assert.equal(resolved[0].ref, "vault:billing/deliverable:billing:v2");
    assert.equal(orphan[0].ref, "vault:analytics/deliverable:analytics:v1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// augmentMatchesWithXRefResolutions
// ---------------------------------------------------------------------------

test("augmentMatchesWithXRefResolutions: adds cross_vault_resolved to matches with vault refs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-aug-"));
  try {
    const worldDir = makeWorldDir(root);
    makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      node: { id: "deliverable:billing:v2", type: "Deliverable", title: "Billing API v2", summary: "The release." }
    });

    // brief.ts compactRelations の実形: 未解決 cross-vault 参照は
    // {relation, direction, to} stub、ローカル参照は {relation, direction, node}。
    const matches = [
      {
        node: { id: "goal:proj:a", type: "Goal" },
        relations: [
          { relation: "has_premise", direction: "out", to: "vault:billing/deliverable:billing:v2" },
          { relation: "reduces_risk", direction: "out", node: { id: "risk:proj:r1", type: "Risk" } }  // local ref, should be ignored
        ]
      },
      {
        node: { id: "decision:proj:b", type: "Decision" },
        relations: []  // no cross-vault refs
      }
    ];

    const augmented = augmentMatchesWithXRefResolutions(matches, worldDir);
    assert.equal(augmented.length, 2);

    // First match should have cross_vault_resolved
    assert.ok("cross_vault_resolved" in augmented[0], "first match should have cross_vault_resolved");
    const xrefs = augmented[0].cross_vault_resolved as any[];
    assert.equal(xrefs.length, 1);
    assert.equal(xrefs[0].ref, "vault:billing/deliverable:billing:v2");
    assert.ok(xrefs[0].resolved !== null);
    assert.equal(xrefs[0].resolved.title, "Billing API v2");
    assert.equal(xrefs[0].edge_type, "has_premise");

    // Second match has no cross-vault refs, should remain unchanged
    assert.ok(!("cross_vault_resolved" in augmented[1]), "second match should not have cross_vault_resolved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("augmentMatchesWithXRefResolutions: returns matches unchanged when worldDir not set", () => {
  const prev = process.env.GRAPHRAG_WORLD_DIR;
  delete process.env.GRAPHRAG_WORLD_DIR;
  try {
    const matches = [
      {
        node: { id: "goal:proj:a", type: "Goal" },
        relations: [{ type: "has_premise", to: "vault:billing/deliverable:billing:v2" }]
      }
    ];
    const augmented = augmentMatchesWithXRefResolutions(matches, undefined);
    // Should be the same reference (no modification)
    assert.strictEqual(augmented, matches);
  } finally {
    if (prev !== undefined) process.env.GRAPHRAG_WORLD_DIR = prev;
  }
});

test("augmentMatchesWithXRefResolutions: resolved is null for unresolvable refs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-aug-"));
  try {
    const worldDir = makeWorldDir(root);
    // no vaults — slug won't be found

    const matches = [
      {
        node: { id: "goal:proj:a", type: "Goal" },
        relations: [{ type: "has_premise", to: "vault:missing/deliverable:missing:x" }]
      }
    ];

    const augmented = augmentMatchesWithXRefResolutions(matches, worldDir);
    const xrefs = augmented[0].cross_vault_resolved as any[];
    assert.equal(xrefs.length, 1);
    assert.equal(xrefs[0].resolved, null);
    assert.equal(xrefs[0].ref, "vault:missing/deliverable:missing:x");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("augmentMatchesWithXRefResolutions: handles empty or null matches gracefully", () => {
  assert.deepEqual(augmentMatchesWithXRefResolutions([], "/some/world"), []);
});

// ---------------------------------------------------------------------------
// vault_slug_aliases — findVaultBySlugWithInfo
// ---------------------------------------------------------------------------

test("findVaultBySlugWithInfo: primary slug match returns matchedViaAlias=false", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-alias-"));
  try {
    const worldDir = makeWorldDir(root);
    makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      aliases: ["billing-old"],
      node: { id: "deliverable:billing:v2", type: "Deliverable", title: "Billing API v2", summary: "x" }
    });

    const result = findVaultBySlugWithInfo("billing", worldDir);
    assert.ok(result !== null);
    assert.equal(result!.currentSlug, "billing");
    assert.equal(result!.matchedViaAlias, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findVaultBySlugWithInfo: alias match returns matchedViaAlias=true and currentSlug", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-alias-"));
  try {
    const worldDir = makeWorldDir(root);
    makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      aliases: ["billing-old"],
      node: { id: "deliverable:billing:v2", type: "Deliverable", title: "Billing API v2", summary: "x" }
    });

    const result = findVaultBySlugWithInfo("billing-old", worldDir);
    assert.ok(result !== null, "should find vault via alias");
    assert.equal(result!.currentSlug, "billing");
    assert.equal(result!.matchedViaAlias, true);
    assert.ok(result!.vaultDir.includes("billing-repo"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findVaultBySlugWithInfo: prefers primary slug over alias when both match (shouldn't happen but is safe)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-alias-"));
  try {
    const worldDir = makeWorldDir(root);
    // vault whose primary slug is "billing"
    makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      node: { id: "deliverable:billing:v2", type: "Deliverable", title: "Billing API v2", summary: "x" }
    });

    const result = findVaultBySlugWithInfo("billing", worldDir);
    assert.ok(result !== null);
    assert.equal(result!.matchedViaAlias, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findVaultBySlug: still works via alias (backwards-compatible wrapper)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-alias-"));
  try {
    const worldDir = makeWorldDir(root);
    makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      aliases: ["billing-old"],
      node: { id: "deliverable:billing:v2", type: "Deliverable", title: "Billing API v2", summary: "x" }
    });

    const vaultDir = findVaultBySlug("billing-old", worldDir);
    assert.ok(vaultDir !== null, "should find vault via alias");
    assert.ok(vaultDir!.includes("billing-repo"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// vault_slug_aliases — checkCrossVaultRefs alias_warning
// ---------------------------------------------------------------------------

test("checkCrossVaultRefs: resolved with alias_warning when ref uses an alias slug", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-alias-check-"));
  try {
    const worldDir = makeWorldDir(root);
    makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      aliases: ["billing-old"],
      node: { id: "deliverable:billing:v2", type: "Deliverable", title: "Billing API v2", summary: "x" }
    });

    const graph = {
      nodes: [{ id: "goal:proj:a", type: "Goal", title: "A", summary: "x" }],
      edges: [
        // ref uses the old alias "billing-old" instead of current slug "billing"
        { id: "e:1", type: "has_premise", from: "goal:proj:a", to: "vault:billing-old/deliverable:billing:v2" }
      ]
    };

    const results = checkCrossVaultRefs(graph, worldDir);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "resolved");
    assert.ok(results[0].alias_warning !== undefined, "should have alias_warning");
    assert.match(results[0].alias_warning ?? "", /billing-old/);
    assert.match(results[0].alias_warning ?? "", /billing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkCrossVaultRefs: no alias_warning when ref uses primary slug", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-alias-check-"));
  try {
    const worldDir = makeWorldDir(root);
    makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      aliases: ["billing-old"],
      node: { id: "deliverable:billing:v2", type: "Deliverable", title: "Billing API v2", summary: "x" }
    });

    const graph = {
      nodes: [{ id: "goal:proj:a", type: "Goal", title: "A", summary: "x" }],
      edges: [
        { id: "e:1", type: "has_premise", from: "goal:proj:a", to: "vault:billing/deliverable:billing:v2" }
      ]
    };

    const results = checkCrossVaultRefs(graph, worldDir);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "resolved");
    assert.equal(results[0].alias_warning, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveCrossVaultRef: resolves cross-vault node via alias", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-alias-resolve-"));
  try {
    const worldDir = makeWorldDir(root);
    makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      aliases: ["billing-old"],
      node: { id: "deliverable:billing:v2", type: "Deliverable", title: "Billing API v2", summary: "The release." }
    });

    // ref uses old alias "billing-old"
    const ref = "vault:billing-old/deliverable:billing:v2";
    const resolved = resolveCrossVaultRef(ref, worldDir);
    assert.ok(resolved !== null, "should resolve via alias");
    assert.equal(resolved!.node_id, "deliverable:billing:v2");
    assert.equal(resolved!.title, "Billing API v2");
    assert.ok(resolved!.vault_path.includes("billing-repo"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// world.json slug fast-path
// ---------------------------------------------------------------------------

test("findVaultBySlugWithInfo: resolves via world.json slug without directory scan", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-world-slug-"));
  try {
    const worldDir = makeWorldDir(root);
    const { vaultDir } = makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      node: { id: "deliverable:billing:v2", type: "Deliverable", title: "Billing API v2", summary: "x" }
    });

    // Write world.json with slug
    writeFileSync(
      path.join(worldDir, "world.json"),
      JSON.stringify({ vaults: [{ path: vaultDir, slug: "billing" }] }, null, 2)
    );

    const result = findVaultBySlugWithInfo("billing", worldDir);
    assert.ok(result !== null);
    assert.equal(result!.currentSlug, "billing");
    assert.equal(result!.matchedViaAlias, false);
    assert.ok(result!.vaultDir.includes("billing-repo"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findVaultBySlugWithInfo: world.json slug takes precedence, absolute paths supported", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-world-slug-"));
  try {
    // Vault NOT inside worldDir — would fail directory scan fallback
    const externalRoot = mkdtempSync(path.join(tmpdir(), "xref-ext-"));
    const extWorldDir = path.join(externalRoot, "ext");
    mkdirSync(extWorldDir, { recursive: true });
    const { vaultDir } = makeVault({
      root: externalRoot,
      repoName: "billing-repo",
      slug: "billing",
      node: { id: "deliverable:billing:v2", type: "Deliverable", title: "Billing API v2", summary: "x" }
    });

    const worldDir = makeWorldDir(root);
    // world.json points to external vault with slug
    writeFileSync(
      path.join(worldDir, "world.json"),
      JSON.stringify({ vaults: [{ path: vaultDir, slug: "billing" }] }, null, 2)
    );

    const result = findVaultBySlugWithInfo("billing", worldDir);
    assert.ok(result !== null, "should find vault via world.json slug even when not in worldDir");
    assert.equal(result!.currentSlug, "billing");

    rmSync(externalRoot, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveCrossVaultRef: resolves via world.json slug for absolute-path vaults", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-world-resolve-"));
  try {
    const externalRoot = mkdtempSync(path.join(tmpdir(), "xref-ext-"));
    const { vaultDir } = makeVault({
      root: externalRoot,
      repoName: "billing-repo",
      slug: "billing",
      node: { id: "deliverable:billing:v2", type: "Deliverable", title: "Billing API v2", summary: "The release." }
    });

    const worldDir = makeWorldDir(root);
    writeFileSync(
      path.join(worldDir, "world.json"),
      JSON.stringify({ vaults: [{ path: vaultDir, slug: "billing" }] }, null, 2)
    );

    const resolved = resolveCrossVaultRef("vault:billing/deliverable:billing:v2", worldDir);
    assert.ok(resolved !== null);
    assert.equal(resolved!.title, "Billing API v2");
    assert.equal(resolved!.node_id, "deliverable:billing:v2");

    rmSync(externalRoot, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// parseVaultParent
// ---------------------------------------------------------------------------

test("parseVaultParent: parses a scalar parent slug", () => {
  const content = `---\nname: child\nschema: project\nvault_slug: child\nparent: program-x\n---\nbody`;
  assert.equal(parseVaultParent(content), "program-x");
});

test("parseVaultParent: returns null when absent", () => {
  const content = `---\nname: child\nschema: project\nvault_slug: child\n---\nbody`;
  assert.equal(parseVaultParent(content), null);
});

test("parseVaultParent: ignores a YAML sequence (single-parent rule)", () => {
  // A list value leaves `parent:` empty → null, structurally enforcing one parent.
  const content = `---\nname: child\nschema: project\nvault_slug: child\nparent:\n  - a\n  - b\n---\nbody`;
  assert.equal(parseVaultParent(content), null);
});

// ---------------------------------------------------------------------------
// checkVaultParent
// ---------------------------------------------------------------------------

const DELIV = (id: string) => ({ id, type: "Deliverable", title: id, summary: "n" });

test("checkVaultParent: status 'none' when no parent declared", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-parent-"));
  try {
    const { vaultDir } = makeVault({ root, repoName: "solo", slug: "solo", node: DELIV("deliverable:solo:a") });
    const res = checkVaultParent(vaultDir, root);
    assert.equal(res.status, "none");
    assert.equal(res.parent_slug, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkVaultParent: 'resolved' for a valid same-schema parent", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-parent-"));
  try {
    makeVault({ root, repoName: "program", slug: "program-x", schema: "project", node: DELIV("deliverable:program-x:a") });
    const { vaultDir } = makeVault({ root, repoName: "child", slug: "child", schema: "project", parent: "program-x", node: DELIV("deliverable:child:a") });
    const res = checkVaultParent(vaultDir, root);
    assert.equal(res.status, "resolved");
    assert.equal(res.parent_slug, "program-x");
    assert.equal(res.resolved?.slug, "program-x");
    assert.equal(res.resolved?.schema, "project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkVaultParent: 'orphan' when parent slug is absent from the world", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-parent-"));
  try {
    const { vaultDir } = makeVault({ root, repoName: "child", slug: "child", schema: "project", parent: "ghost", node: DELIV("deliverable:child:a") });
    const res = checkVaultParent(vaultDir, root);
    assert.equal(res.status, "orphan");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkVaultParent: 'self' when parent points to the vault's own slug", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-parent-"));
  try {
    const { vaultDir } = makeVault({ root, repoName: "child", slug: "child", schema: "project", parent: "child", node: DELIV("deliverable:child:a") });
    const res = checkVaultParent(vaultDir, root);
    assert.equal(res.status, "self");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkVaultParent: 'schema-mismatch' when parent uses a different schema", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-parent-"));
  try {
    makeVault({ root, repoName: "platform", slug: "platform", schema: "system", node: DELIV("deliverable:platform:a") });
    const { vaultDir } = makeVault({ root, repoName: "proj", slug: "proj", schema: "project", parent: "platform", node: DELIV("deliverable:proj:a") });
    const res = checkVaultParent(vaultDir, root);
    assert.equal(res.status, "schema-mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkVaultParent: 'cycle' when the parent chain loops", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-parent-"));
  try {
    // a -> b -> a
    makeVault({ root, repoName: "a", slug: "a", schema: "project", parent: "b", node: DELIV("deliverable:a:x") });
    const { vaultDir: bDir } = makeVault({ root, repoName: "b", slug: "b", schema: "project", parent: "a", node: DELIV("deliverable:b:x") });
    const res = checkVaultParent(bDir, root);
    assert.equal(res.status, "cycle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkVaultParent: alias_warning when parent matches via a vault_slug_alias", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-parent-"));
  try {
    makeVault({ root, repoName: "program", slug: "program-x", schema: "project", aliases: ["old-program"], node: DELIV("deliverable:program-x:a") });
    const { vaultDir } = makeVault({ root, repoName: "child", slug: "child", schema: "project", parent: "old-program", node: DELIV("deliverable:child:a") });
    const res = checkVaultParent(vaultDir, root);
    assert.equal(res.status, "resolved");
    assert.ok(res.alias_warning && res.alias_warning.includes("program-x"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkVaultParent: 'unresolvable' when no world dir is available", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-parent-"));
  const savedWorld = process.env.GRAPHRAG_WORLD_DIR;
  delete process.env.GRAPHRAG_WORLD_DIR;
  try {
    const { vaultDir } = makeVault({ root, repoName: "child", slug: "child", schema: "project", parent: "program-x", node: DELIV("deliverable:child:a") });
    const res = checkVaultParent(vaultDir);
    assert.equal(res.status, "unresolvable");
  } finally {
    if (savedWorld !== undefined) process.env.GRAPHRAG_WORLD_DIR = savedWorld;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// brief → augment integration (compactRelations stub → cross_vault_resolved)
// ---------------------------------------------------------------------------

import { buildQueryBrief } from "./brief.ts";

test("brief matches with unresolved cross-vault edges get cross_vault_resolved via augment", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-brief-aug-"));
  try {
    const worldDir = makeWorldDir(root);
    makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      node: { id: "deliverable:billing:v2", type: "Deliverable", title: "Billing API v2", summary: "The release." }
    });

    // ローカル graph: match ノードが vault:billing/... への edge を持つ
    // (宛先はローカルに実体なし → compactRelations は stub を出すはず)。
    const graph = {
      nodes: [{ id: "goal:proj:a", type: "Goal", title: "認証基盤", summary: "x" }],
      edges: [
        { id: "e:x", type: "has_premise", from: "goal:proj:a", to: "vault:billing/deliverable:billing:v2" }
      ]
    };
    const out = await buildQueryBrief(graph, new Map(graph.nodes.map((n) => [n.id, n])), {
      query: "認証基盤",
      vectorIndex: { provider: "fake", rows: [] },
      queryVectors: [[0]],
      limit: 5
    });
    assert.equal(out.matches.length, 1);
    const augmented = augmentMatchesWithXRefResolutions(out.matches, worldDir);
    const xrefs = augmented[0].cross_vault_resolved as any[];
    assert.ok(Array.isArray(xrefs) && xrefs.length === 1,
      "brief 出力の stub を xref-resolver が拾って cross_vault_resolved を付ける");
    assert.equal(xrefs[0].ref, "vault:billing/deliverable:billing:v2");
    assert.equal(xrefs[0].edge_type, "has_premise");
    assert.equal(xrefs[0].resolved?.title, "Billing API v2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── issue #18: tombstone (削除台帳) 参照解決 ─────────────────────────────────

test("checkCrossVaultRefs: 台帳に載った削除済みノードは tombstoned (301) で後継と生存を返す", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-check-"));
  try {
    const worldDir = makeWorldDir(root);
    const { vaultDir } = makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      node: { id: "deliverable:billing:v3", type: "Deliverable", title: "successor node", summary: "s" }
    });
    // 旧ノード deliverable:billing:v2 は存在せず、台帳が v3 を後継として知っている。
    appendTombstones(vaultDir, [
      { id: "deliverable:billing:v2", deleted_at: "2026-07-13T00:00:00.000Z", reason: "purge", successor: "deliverable:billing:v3" }
    ]);

    const graph = {
      nodes: [{ id: "goal:proj:a", type: "Goal", title: "A", summary: "x" }],
      edges: [
        { id: "e:1", type: "has_premise", from: "goal:proj:a", to: "vault:billing/deliverable:billing:v2" }
      ]
    };

    const results = checkCrossVaultRefs(graph, worldDir);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "tombstoned");
    assert.equal(results[0].tombstone?.final_successor, "deliverable:billing:v3");
    assert.equal(results[0].tombstone?.successor_alive, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkCrossVaultRefs: 後継無しの tombstone は final_successor null (410)、台帳に無い欠落は従来どおり broken", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xref-check-"));
  try {
    const worldDir = makeWorldDir(root);
    const { vaultDir } = makeVault({
      root: worldDir,
      repoName: "billing-repo",
      slug: "billing",
      node: { id: "deliverable:billing:alive", type: "Deliverable", title: "alive", summary: "a" }
    });
    appendTombstones(vaultDir, [
      { id: "deliverable:billing:gone", deleted_at: "2026-07-13T00:00:00.000Z", reason: "purge" }
    ]);

    const graph = {
      nodes: [{ id: "goal:proj:a", type: "Goal", title: "A", summary: "x" }],
      edges: [
        { id: "e:1", type: "has_premise", from: "goal:proj:a", to: "vault:billing/deliverable:billing:gone" },
        { id: "e:2", type: "has_premise", from: "goal:proj:a", to: "vault:billing/deliverable:billing:never-existed" }
      ]
    };

    const results = checkCrossVaultRefs(graph, worldDir);
    const gone = results.find((r) => r.edge_id === "e:1");
    const never = results.find((r) => r.edge_id === "e:2");
    assert.equal(gone?.status, "tombstoned");
    assert.equal(gone?.tombstone?.final_successor, null);
    assert.equal(gone?.tombstone?.successor_alive, null);
    assert.equal(never?.status, "broken");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
import { appendTombstones } from "./tombstones.ts";
