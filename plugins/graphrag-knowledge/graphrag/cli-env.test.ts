import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDotEnv, applyDotEnv, discoverVaultDir, discoverAndLoadGraphragEnv, loadHomeGraphragEnv, stateDirUnder, stateDirForVault, discoverStateDir } from "./cli-env.ts";

// 回帰: state dir (.graphrag) の解決は冪等であること。
// 既定レイアウト <root>/.graphrag/vault に対して <root>/.graphrag/.graphrag や
// <root>/.graphrag/vault/.graphrag を掘っていたのが本バグの正体。
test("stateDirUnder: legacy/sibling layout — <root> → <root>/.graphrag", () => {
  assert.equal(stateDirUnder("/repo"), path.join("/repo", ".graphrag"));
});

test("stateDirUnder: idempotent — already-.graphrag dir returns itself (no nesting)", () => {
  const g = path.join("/repo", ".graphrag");
  assert.equal(stateDirUnder(g), g);
});

test("stateDirForVault: default layout <root>/.graphrag/vault → <root>/.graphrag (not .graphrag/.graphrag)", () => {
  const root = "/repo";
  const vault = path.join(root, ".graphrag", "vault");
  assert.equal(stateDirForVault(vault), path.join(root, ".graphrag"));
});

test("stateDirForVault: legacy layout <root>/vault → <root>/.graphrag", () => {
  const root = "/repo";
  assert.equal(stateDirForVault(path.join(root, "vault")), path.join(root, ".graphrag"));
});

test("discoverStateDir: walks up to an existing .graphrag even from inside the vault (not vault/.graphrag)", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "statedir-")));
  try {
    const stateDir = path.join(root, ".graphrag");
    const vault = path.join(stateDir, "vault");
    mkdirSync(vault, { recursive: true });
    // vault ディレクトリ内から実行しても <root>/.graphrag を辿り当てる。
    assert.equal(discoverStateDir(vault), stateDir);
    // <root>/.graphrag 直下からでも自分自身を返す (掘り増やさない)。
    assert.equal(discoverStateDir(stateDir), stateDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

// ── #14: closest .graphrag/ wins over a parent .graphrag/.env ──

function withCleanVaultEnv(fn: (root: string) => void): void {
  const original = process.env.GRAPHRAG_VAULT_DIR;
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "grag-root-")));
  try {
    delete process.env.GRAPHRAG_VAULT_DIR;
    fn(root);
  } finally {
    if (original === undefined) delete process.env.GRAPHRAG_VAULT_DIR;
    else process.env.GRAPHRAG_VAULT_DIR = original;
    rmSync(root, { recursive: true, force: true });
  }
}

test("local .graphrag/vault wins over parent .graphrag/.env (no local .env)", () => {
  // worktree subdir has its own vault (e.g. from rebase) but no local .env;
  // the parent repo has a .graphrag/.env pointing at its own vault. The local
  // vault must win — the parent's .env must NOT clobber it.
  withCleanVaultEnv((root) => {
    const parentVault = path.join(root, ".graphrag", "vault");
    mkdirSync(parentVault, { recursive: true });
    writeFileSync(path.join(root, ".graphrag", ".env"), `GRAPHRAG_VAULT_DIR=${parentVault}\n`);

    const sub = path.join(root, ".claude", "worktrees", "foo");
    const localVault = path.join(sub, ".graphrag", "vault");
    mkdirSync(localVault, { recursive: true });

    discoverAndLoadGraphragEnv(sub);
    discoverVaultDir(sub);
    assert.equal(process.env.GRAPHRAG_VAULT_DIR, localVault);
  });
});

test("local .graphrag/.env wins over parent .graphrag/.env", () => {
  withCleanVaultEnv((root) => {
    mkdirSync(path.join(root, ".graphrag", "vault"), { recursive: true });
    writeFileSync(
      path.join(root, ".graphrag", ".env"),
      `GRAPHRAG_VAULT_DIR=${path.join(root, ".graphrag", "vault")}\n`
    );

    const sub = path.join(root, ".claude", "worktrees", "foo");
    const localVault = path.join(sub, ".graphrag", "vault");
    mkdirSync(localVault, { recursive: true });
    writeFileSync(path.join(sub, ".graphrag", ".env"), `GRAPHRAG_VAULT_DIR=${localVault}\n`);

    discoverAndLoadGraphragEnv(sub);
    discoverVaultDir(sub);
    assert.equal(process.env.GRAPHRAG_VAULT_DIR, localVault);
  });
});

test("parent .graphrag/.env is inherited when the subdir has no local .graphrag/", () => {
  // No local graphrag root at all → walk up and inherit the parent's .env.
  withCleanVaultEnv((root) => {
    const parentVault = path.join(root, ".graphrag", "vault");
    mkdirSync(parentVault, { recursive: true });
    writeFileSync(path.join(root, ".graphrag", ".env"), `GRAPHRAG_VAULT_DIR=${parentVault}\n`);

    const sub = path.join(root, "a", "b");
    mkdirSync(sub, { recursive: true });

    discoverAndLoadGraphragEnv(sub);
    discoverVaultDir(sub);
    assert.equal(process.env.GRAPHRAG_VAULT_DIR, parentVault);
  });
});

// ── ~/.graphrag/.env: env-wide global fallback (embedding endpoint etc.) ──

function withCleanEmbeddingEnv(fn: (home: string) => void): void {
  const originals = {
    GRAPHRAG_EMBEDDING_ENDPOINT: process.env.GRAPHRAG_EMBEDDING_ENDPOINT,
    GRAPHRAG_VAULT_DIR: process.env.GRAPHRAG_VAULT_DIR,
  };
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "grag-home-")));
  try {
    delete process.env.GRAPHRAG_EMBEDDING_ENDPOINT;
    delete process.env.GRAPHRAG_VAULT_DIR;
    fn(home);
  } finally {
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test("loadHomeGraphragEnv fills an unset key from ~/.graphrag/.env", () => {
  withCleanEmbeddingEnv((home) => {
    mkdirSync(path.join(home, ".graphrag"), { recursive: true });
    writeFileSync(
      path.join(home, ".graphrag", ".env"),
      "GRAPHRAG_EMBEDDING_ENDPOINT=http://localhost:11434/v1\n"
    );
    loadHomeGraphragEnv(home);
    assert.equal(process.env.GRAPHRAG_EMBEDDING_ENDPOINT, "http://localhost:11434/v1");
  });
});

test("loadHomeGraphragEnv does NOT overwrite a value already set by local config", () => {
  withCleanEmbeddingEnv((home) => {
    mkdirSync(path.join(home, ".graphrag"), { recursive: true });
    writeFileSync(
      path.join(home, ".graphrag", ".env"),
      "GRAPHRAG_EMBEDDING_ENDPOINT=http://home-default:11434/v1\n"
    );
    // simulate local .graphrag/.env having already applied a value
    process.env.GRAPHRAG_EMBEDDING_ENDPOINT = "http://local-wins:1234/v1";
    loadHomeGraphragEnv(home);
    assert.equal(process.env.GRAPHRAG_EMBEDDING_ENDPOINT, "http://local-wins:1234/v1");
  });
});

test("loadHomeGraphragEnv is a no-op when ~/.graphrag/.env is absent", () => {
  withCleanEmbeddingEnv((home) => {
    loadHomeGraphragEnv(home);
    assert.equal(process.env.GRAPHRAG_EMBEDDING_ENDPOINT, undefined);
  });
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
