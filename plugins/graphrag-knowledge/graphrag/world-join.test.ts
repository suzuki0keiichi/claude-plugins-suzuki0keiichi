import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { worldJoin, upsertDotEnvKey } from "./world-join.ts";

function makeVault(root: string, name: string, profile?: string): string {
  const vaultDir = path.join(root, name, ".graphrag", "vault");
  mkdirSync(vaultDir, { recursive: true });
  if (profile) {
    writeFileSync(path.join(root, name, ".graphrag", "VAULT.md"), profile);
  }
  return vaultDir;
}

function graphragDirOf(vaultDir: string): string {
  return path.dirname(vaultDir);
}

function makeWorldDir(root: string): string {
  const worldDir = path.join(root, "world");
  mkdirSync(worldDir, { recursive: true });
  return worldDir;
}

// --- upsertDotEnvKey ---

test("upsertDotEnvKey creates .env file if absent", () => {
  const root = mkdtempSync(path.join(tmpdir(), "grag-join-"));
  try {
    const envPath = path.join(root, "sub", ".env");
    upsertDotEnvKey(envPath, "FOO", "bar");
    assert.equal(readFileSync(envPath, "utf8"), "FOO=bar\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upsertDotEnvKey appends to existing .env", () => {
  const root = mkdtempSync(path.join(tmpdir(), "grag-join-"));
  try {
    const envPath = path.join(root, ".env");
    writeFileSync(envPath, "EXISTING=value\n");
    upsertDotEnvKey(envPath, "NEW_KEY", "/some/path");
    const content = readFileSync(envPath, "utf8");
    assert.match(content, /EXISTING=value/);
    assert.match(content, /NEW_KEY=\/some\/path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upsertDotEnvKey updates existing key in place", () => {
  const root = mkdtempSync(path.join(tmpdir(), "grag-join-"));
  try {
    const envPath = path.join(root, ".env");
    writeFileSync(envPath, "AAA=1\nGRAPHRAG_WORLD_DIR=/old/path\nBBB=2\n");
    upsertDotEnvKey(envPath, "GRAPHRAG_WORLD_DIR", "/new/path");
    const content = readFileSync(envPath, "utf8");
    assert.match(content, /GRAPHRAG_WORLD_DIR=\/new\/path/);
    assert.doesNotMatch(content, /\/old\/path/);
    assert.match(content, /AAA=1/);
    assert.match(content, /BBB=2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upsertDotEnvKey no-ops when value already matches", () => {
  const root = mkdtempSync(path.join(tmpdir(), "grag-join-"));
  try {
    const envPath = path.join(root, ".env");
    const original = "KEY=/same/path\n";
    writeFileSync(envPath, original);
    upsertDotEnvKey(envPath, "KEY", "/same/path");
    assert.equal(readFileSync(envPath, "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- worldJoin ---

test("worldJoin creates world.json with slug when VAULT.md has vault_slug", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grag-join-"));
  try {
    const profile = `---\nname: repo-a\nvault_slug: repo-a\n---\nA vault.\n`;
    const vaultDir = makeVault(root, "repo-a", profile);
    const worldDir = makeWorldDir(root);

    const result = await worldJoin({ vaultDir, worldDir, graphragDir: graphragDirOf(vaultDir) });

    assert.equal(result.world_json_updated, true);
    assert.equal(result.vault_slug, "repo-a");

    const worldJson = JSON.parse(readFileSync(path.join(worldDir, "world.json"), "utf8"));
    assert.equal(worldJson.vaults.length, 1);
    assert.equal(worldJson.vaults[0].path, path.resolve(vaultDir));
    assert.equal(worldJson.vaults[0].slug, "repo-a");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worldJoin creates world.json without slug when VAULT.md has no vault_slug", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grag-join-"));
  try {
    const profile = `---\nname: repo-a\n---\nA vault.\n`;
    const vaultDir = makeVault(root, "repo-a", profile);
    const worldDir = makeWorldDir(root);

    const result = await worldJoin({ vaultDir, worldDir, graphragDir: graphragDirOf(vaultDir) });

    assert.equal(result.vault_slug, null);
    assert.match(result.message, /no vault_slug/);

    const worldJson = JSON.parse(readFileSync(path.join(worldDir, "world.json"), "utf8"));
    assert.equal(worldJson.vaults[0].path, path.resolve(vaultDir));
    assert.equal(worldJson.vaults[0].slug, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worldJoin writes .env to the graphragDir, not the vault parent", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grag-join-"));
  try {
    // Simulate external vault: vault is in a different tree than the local .graphrag
    const localGraphrag = path.join(root, "local-project", ".graphrag");
    mkdirSync(localGraphrag, { recursive: true });

    const externalRoot = mkdtempSync(path.join(tmpdir(), "grag-ext-"));
    const vaultDir = path.join(externalRoot, "vault");
    mkdirSync(vaultDir, { recursive: true });

    const worldDir = makeWorldDir(root);

    const result = await worldJoin({ vaultDir, worldDir, graphragDir: localGraphrag });
    assert.equal(result.env_updated, true);
    assert.equal(result.env_path, path.join(localGraphrag, ".env"));

    const envContent = readFileSync(path.join(localGraphrag, ".env"), "utf8");
    assert.match(envContent, /GRAPHRAG_WORLD_DIR/);

    // Ensure it did NOT write to the external vault's parent
    assert.equal(existsSync(path.join(externalRoot, ".env")), false);

    rmSync(externalRoot, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worldJoin appends vault to existing world.json without duplicating", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grag-join-"));
  try {
    const vaultA = makeVault(root, "repo-a");
    const profileB = `---\nname: repo-b\nvault_slug: repo-b\n---\nB vault.\n`;
    const vaultB = makeVault(root, "repo-b", profileB);
    const worldDir = makeWorldDir(root);

    writeFileSync(
      path.join(worldDir, "world.json"),
      JSON.stringify({ vaults: [path.resolve(vaultA)] }, null, 2)
    );

    const result = await worldJoin({ vaultDir: vaultB, worldDir, graphragDir: graphragDirOf(vaultB) });
    assert.equal(result.world_json_updated, true);

    const worldJson = JSON.parse(readFileSync(path.join(worldDir, "world.json"), "utf8"));
    assert.equal(worldJson.vaults.length, 2);
    const bEntry = worldJson.vaults.find((v: any) => (typeof v === "object" ? v.path : v) === path.resolve(vaultB));
    assert.ok(bEntry);
    assert.equal(bEntry.slug, "repo-b");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worldJoin is idempotent (no-op when already joined)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grag-join-"));
  try {
    const profile = `---\nname: repo-a\nvault_slug: repo-a\n---\nA.\n`;
    const vaultDir = makeVault(root, "repo-a", profile);
    const worldDir = makeWorldDir(root);
    const graphragDir = graphragDirOf(vaultDir);

    await worldJoin({ vaultDir, worldDir, graphragDir });
    const result = await worldJoin({ vaultDir, worldDir, graphragDir });

    assert.equal(result.world_json_updated, false);
    assert.equal(result.env_updated, false);

    const worldJson = JSON.parse(readFileSync(path.join(worldDir, "world.json"), "utf8"));
    assert.equal(worldJson.vaults.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worldJoin warns when VAULT.md is missing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grag-join-"));
  try {
    const vaultDir = makeVault(root, "repo-a"); // no profile
    const worldDir = makeWorldDir(root);

    const result = await worldJoin({ vaultDir, worldDir, graphragDir: graphragDirOf(vaultDir) });
    assert.match(result.message, /VAULT\.md not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worldJoin creates world directory if it does not exist", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grag-join-"));
  try {
    const vaultDir = makeVault(root, "repo-a");
    const worldDir = path.join(root, "nonexistent", "world");

    const result = await worldJoin({ vaultDir, worldDir, graphragDir: graphragDirOf(vaultDir) });
    assert.equal(result.world_json_updated, true);
    assert.ok(existsSync(path.join(worldDir, "world.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worldJoin throws when vault directory does not exist", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grag-join-"));
  try {
    const worldDir = makeWorldDir(root);
    await assert.rejects(
      worldJoin({ vaultDir: path.join(root, "no-such-vault"), worldDir }),
      /vault directory does not exist/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worldJoin uses custom graphragDir for .env placement", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grag-join-"));
  try {
    const vaultDir = makeVault(root, "repo-a");
    const worldDir = makeWorldDir(root);
    const customDir = path.join(root, "custom-graphrag");
    mkdirSync(customDir, { recursive: true });

    const result = await worldJoin({ vaultDir, worldDir, graphragDir: customDir });
    assert.equal(result.env_path, path.join(customDir, ".env"));
    assert.ok(existsSync(path.join(customDir, ".env")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
