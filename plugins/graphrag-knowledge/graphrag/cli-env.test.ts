import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDotEnv, applyDotEnv, discoverVaultDir } from "./cli-env.ts";

test("parseDotEnv handles plain KEY=value", () => {
  const out = parseDotEnv("FOO=bar\nBAZ=qux\n");
  assert.deepEqual(out, { FOO: "bar", BAZ: "qux" });
});

test("parseDotEnv strips export prefix", () => {
  const out = parseDotEnv("export FOO=bar\n");
  assert.deepEqual(out, { FOO: "bar" });
});

test("parseDotEnv handles single and double quoted values", () => {
  const out = parseDotEnv('FOO="hello world"\nBAR=\'a b c\'\n');
  assert.deepEqual(out, { FOO: "hello world", BAR: "a b c" });
});

test("parseDotEnv ignores comments and blank lines", () => {
  const out = parseDotEnv("# comment\n\nFOO=bar\n# another\n");
  assert.deepEqual(out, { FOO: "bar" });
});

test("parseDotEnv ignores lines without =", () => {
  const out = parseDotEnv("FOO=bar\nNOT_A_VAR\nBAZ=qux\n");
  assert.deepEqual(out, { FOO: "bar", BAZ: "qux" });
});

test("discoverVaultDir finds .graphrag/vault walking up from cwd", () => {
  const original = process.env.GRAPHRAG_VAULT_DIR;
  const root = mkdtempSync(path.join(tmpdir(), "grag-disc-"));
  try {
    const vault = path.join(root, ".graphrag", "vault");
    mkdirSync(vault, { recursive: true });
    const nested = path.join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    delete process.env.GRAPHRAG_VAULT_DIR;
    discoverVaultDir(nested);
    assert.equal(process.env.GRAPHRAG_VAULT_DIR, vault);
  } finally {
    if (original === undefined) delete process.env.GRAPHRAG_VAULT_DIR;
    else process.env.GRAPHRAG_VAULT_DIR = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverVaultDir is a no-op when GRAPHRAG_VAULT_DIR already set", () => {
  const original = process.env.GRAPHRAG_VAULT_DIR;
  const root = mkdtempSync(path.join(tmpdir(), "grag-disc-"));
  try {
    mkdirSync(path.join(root, ".graphrag", "vault"), { recursive: true });
    process.env.GRAPHRAG_VAULT_DIR = "/preset/vault";
    discoverVaultDir(root);
    assert.equal(process.env.GRAPHRAG_VAULT_DIR, "/preset/vault");
  } finally {
    if (original === undefined) delete process.env.GRAPHRAG_VAULT_DIR;
    else process.env.GRAPHRAG_VAULT_DIR = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverVaultDir leaves env unset when no .graphrag/vault exists", () => {
  const original = process.env.GRAPHRAG_VAULT_DIR;
  const root = mkdtempSync(path.join(tmpdir(), "grag-disc-"));
  try {
    delete process.env.GRAPHRAG_VAULT_DIR;
    discoverVaultDir(root);
    assert.equal(process.env.GRAPHRAG_VAULT_DIR, undefined);
  } finally {
    if (original === undefined) delete process.env.GRAPHRAG_VAULT_DIR;
    else process.env.GRAPHRAG_VAULT_DIR = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyDotEnv does not overwrite existing process.env entries", () => {
  const originalFoo = process.env.FOO_CLITEST;
  const originalBar = process.env.BAR_CLITEST;
  try {
    process.env.FOO_CLITEST = "preset";
    delete process.env.BAR_CLITEST;
    applyDotEnv({ FOO_CLITEST: "fromenv", BAR_CLITEST: "new" });
    assert.equal(process.env.FOO_CLITEST, "preset");
    assert.equal(process.env.BAR_CLITEST, "new");
  } finally {
    if (originalFoo === undefined) delete process.env.FOO_CLITEST;
    else process.env.FOO_CLITEST = originalFoo;
    if (originalBar === undefined) delete process.env.BAR_CLITEST;
    else process.env.BAR_CLITEST = originalBar;
  }
});
