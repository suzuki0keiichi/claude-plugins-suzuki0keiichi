import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseDotEnv, applyDotEnv, discoverVaultDir, discoverAndLoadGraphragEnv, loadHomeGraphragEnv,
  loadDotEnvFromCwd, bindClosestVaultDir,
  stateDirUnder, stateDirForVault, discoverStateDir,
  cacheDirUnder, cacheDirForVault, consumerCacheDirForVault,
  detectVaultIsolation, assertVaultWriteAllowed, resetWorktreeModeWarningForTest
} from "./cli-env.ts";
import { execFileSync } from "node:child_process";

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

test("discoverStateDir: どこにも .graphrag が無ければ null (cwd に勝手に掘る候補を返さない)", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "statedir-none-")));
  try {
    assert.equal(discoverStateDir(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── E1: 機械ローカル成果物の cache dir ──

test("cacheDirUnder / cacheDirForVault: <stateDir>/cache を冪等に解決する", () => {
  const g = path.join("/repo", ".graphrag");
  assert.equal(cacheDirUnder(g), path.join(g, "cache"));
  // 冪等: 既に cache を渡しても掘り増やさない
  assert.equal(cacheDirUnder(path.join(g, "cache")), path.join(g, "cache"));
  // 既定レイアウト <root>/.graphrag/vault → <root>/.graphrag/cache
  assert.equal(cacheDirForVault(path.join(g, "vault")), path.join(g, "cache"));
  // legacy レイアウト <root>/vault → <root>/.graphrag/cache
  assert.equal(cacheDirForVault(path.join("/repo", "vault")), path.join(g, "cache"));
});

test("consumerCacheDirForVault: ローカル root の cache/external/<hash> を返す (root 不在は null)", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "consumer-")));
  try {
    mkdirSync(path.join(root, ".graphrag"), { recursive: true });
    const dir = consumerCacheDirForVault("/ext/repo/.graphrag/vault", root);
    assert.ok(dir !== null);
    assert.ok(dir!.startsWith(path.join(root, ".graphrag", "cache", "external") + path.sep));
    // 同じ vault パスなら安定 (hash キー)
    assert.equal(dir, consumerCacheDirForVault("/ext/repo/.graphrag/vault", root));
    // 別 vault なら別サブディレクトリ
    assert.notEqual(dir, consumerCacheDirForVault("/other/vault", root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("consumerCacheDirForVault: ローカルに .graphrag が無ければ null", () => {
  const bare = realpathSync(mkdtempSync(path.join(tmpdir(), "consumer-bare-")));
  try {
    assert.equal(consumerCacheDirForVault("/ext/vault", bare), null);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

// ── vault mode / 書き込みゲート ──

// #1 回帰: mode は「書き込み」ポリシー。legacy な worktree 値が .env に残っている
// アップグレード後の環境でも、ask のような read verb は死んではいけない。
test("GRAPHRAG_VAULT_MODE=worktree はもう read を落とさない (未設定扱い + stderr 警告 1 回)", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mode-wt-")));
  const originalWrite = process.stderr.write.bind(process.stderr);
  const warnings: string[] = [];
  process.stderr.write = ((chunk: any) => { warnings.push(String(chunk)); return true; }) as any;
  try {
    mkdirSync(path.join(root, ".graphrag"), { recursive: true });
    writeFileSync(path.join(root, ".graphrag", ".env"), "GRAPHRAG_VAULT_MODE=worktree\n");
    resetWorktreeModeWarningForTest();

    const isolation1 = detectVaultIsolation(root);
    assert.equal(isolation1.mode, null);
    assert.equal(isolation1.raw_mode, null);

    // 同一プロセス内で複数回呼んでも警告は 1 回だけ (ask は複数回 detectVaultIsolation を呼びうる)。
    detectVaultIsolation(root);
    detectVaultIsolation(root);
    const wtWarnings = warnings.filter((w) => /GRAPHRAG_VAULT_MODE=worktree is not implemented/.test(w));
    assert.equal(wtWarnings.length, 1);
  } finally {
    process.stderr.write = originalWrite;
    resetWorktreeModeWarningForTest();
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertVaultWriteAllowed: readonly は書き込みを拒否、direct は通す", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mode-gate-")));
  try {
    mkdirSync(path.join(root, ".graphrag"), { recursive: true });
    writeFileSync(path.join(root, ".graphrag", ".env"), "GRAPHRAG_VAULT_MODE=readonly\n");
    assert.throws(
      () => assertVaultWriteAllowed({ cwd: root, vaultDir: path.join(root, ".graphrag", "vault") }),
      /readonly/
    );
    writeFileSync(path.join(root, ".graphrag", ".env"), "GRAPHRAG_VAULT_MODE=direct\n");
    const isolation = assertVaultWriteAllowed({ cwd: root, vaultDir: path.join(root, ".graphrag", "vault") });
    assert.equal(isolation.mode, "direct");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertVaultWriteAllowed: 外部 vault + ローカル mode 無しは拒否 (存在しない vault-worktree verb を案内しない)", () => {
  const cwdRepo = realpathSync(mkdtempSync(path.join(tmpdir(), "gate-cwd-")));
  const vaultRepo = realpathSync(mkdtempSync(path.join(tmpdir(), "gate-vault-")));
  try {
    for (const repo of [cwdRepo, vaultRepo]) {
      execFileSync("git", ["-C", repo, "init", "-q"]);
    }
    const vaultDir = path.join(vaultRepo, "vault");
    mkdirSync(vaultDir, { recursive: true });
    assert.throws(
      () => assertVaultWriteAllowed({ cwd: cwdRepo, vaultDir }),
      (e: any) => {
        assert.match(e.message, /external/);
        assert.match(e.message, /GRAPHRAG_VAULT_MODE=readonly/);
        assert.match(e.message, /GRAPHRAG_VAULT_MODE=direct/);
        assert.ok(!/vault-worktree/.test(e.message), "存在しない verb を案内しない");
        assert.ok(!/GRAPHRAG_VAULT_MODE=worktree/.test(e.message), "未実装 mode を案内しない");
        return true;
      }
    );
  } finally {
    rmSync(cwdRepo, { recursive: true, force: true });
    rmSync(vaultRepo, { recursive: true, force: true });
  }
});

// #3 回帰: 制限的な (readonly) 設定は継承してよい。demote 後の `mode` は
// worktree ごとの再宣言を要求するために null になるが、`raw_mode` は
// inherited でも parse 結果をそのまま持ち続け、消費側 cache のルーティングに使える。
test("detectVaultIsolation: 外部 vault + inherited readonly は mode を demote するが raw_mode は保つ", () => {
  const parentRepo = realpathSync(mkdtempSync(path.join(tmpdir(), "raw-parent-")));
  const vaultRepo = realpathSync(mkdtempSync(path.join(tmpdir(), "raw-vault-")));
  const original = process.env.GRAPHRAG_VAULT_MODE;
  try {
    for (const repo of [parentRepo, vaultRepo]) {
      execFileSync("git", ["-C", repo, "init", "-q"]);
    }
    const vaultDir = path.join(vaultRepo, "vault");
    mkdirSync(vaultDir, { recursive: true });

    // 親の .graphrag/.env を worktree (子) が継承した状態を process.env で再現する
    // (discoverAndLoadGraphragEnv が実際の CLI 起動シーケンスでこれをやる)。
    process.env.GRAPHRAG_VAULT_MODE = "readonly";
    const worktreeSub = path.join(parentRepo, ".claude", "worktrees", "child");
    mkdirSync(worktreeSub, { recursive: true });

    const isolation = detectVaultIsolation(worktreeSub, vaultDir);
    assert.equal(isolation.mode_source, "inherited");
    assert.equal(isolation.mode, null, "demote: worktree ごとのローカル決定を要求する");
    assert.equal(isolation.raw_mode, "readonly", "raw_mode は demote されない");
  } finally {
    if (original === undefined) delete process.env.GRAPHRAG_VAULT_MODE;
    else process.env.GRAPHRAG_VAULT_MODE = original;
    rmSync(parentRepo, { recursive: true, force: true });
    rmSync(vaultRepo, { recursive: true, force: true });
  }
});

// #3 回帰: raw_mode の追加で書き込みゲートの意味は変わらない。inherited な direct は
// 依然として外部 vault への書き込みを許可しない (demotion の理由そのもの)。
test("assertVaultWriteAllowed: inherited な direct は外部 vault への書き込みを許可しない", () => {
  const parentRepo = realpathSync(mkdtempSync(path.join(tmpdir(), "wg-parent-")));
  const vaultRepo = realpathSync(mkdtempSync(path.join(tmpdir(), "wg-vault-")));
  const original = process.env.GRAPHRAG_VAULT_MODE;
  try {
    for (const repo of [parentRepo, vaultRepo]) {
      execFileSync("git", ["-C", repo, "init", "-q"]);
    }
    const vaultDir = path.join(vaultRepo, "vault");
    mkdirSync(vaultDir, { recursive: true });

    process.env.GRAPHRAG_VAULT_MODE = "direct";
    const worktreeSub = path.join(parentRepo, ".claude", "worktrees", "child");
    mkdirSync(worktreeSub, { recursive: true });

    assert.throws(
      () => assertVaultWriteAllowed({ cwd: worktreeSub, vaultDir }),
      (e: any) => {
        assert.match(e.message, /external/);
        assert.match(e.message, /parent directory has a mode setting/);
        return true;
      }
    );
  } finally {
    if (original === undefined) delete process.env.GRAPHRAG_VAULT_MODE;
    else process.env.GRAPHRAG_VAULT_MODE = original;
    rmSync(parentRepo, { recursive: true, force: true });
    rmSync(vaultRepo, { recursive: true, force: true });
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

// ── E2: 最近傍 .graphrag/vault は cwd .env の stale な値に勝つ ──

test("E2: closest .graphrag/vault が cwd .env の stale な GRAPHRAG_VAULT_DIR に勝つ", () => {
  withCleanVaultEnv((root) => {
    const localVault = path.join(root, ".graphrag", "vault");
    mkdirSync(localVault, { recursive: true });
    // プロジェクト直下の素朴な .env に stale なパスが残っている状況
    writeFileSync(path.join(root, ".env"), `GRAPHRAG_VAULT_DIR=${path.join(root, "no-longer-here", "vault")}\n`);
    // runCli の env 読み込み順を再現
    discoverAndLoadGraphragEnv(root);
    bindClosestVaultDir(root);
    loadDotEnvFromCwd(root);
    discoverVaultDir(root);
    assert.equal(process.env.GRAPHRAG_VAULT_DIR, localVault, "closest-wins は cwd .env より強い");
  });
});

test("E2: シェル env は bindClosestVaultDir より常に強い (first-wins)", () => {
  withCleanVaultEnv((root) => {
    mkdirSync(path.join(root, ".graphrag", "vault"), { recursive: true });
    process.env.GRAPHRAG_VAULT_DIR = "/from/shell/vault";
    bindClosestVaultDir(root);
    assert.equal(process.env.GRAPHRAG_VAULT_DIR, "/from/shell/vault");
  });
});

test("E2: root の .graphrag/.env が GRAPHRAG_VAULT_DIR を明示していればそれを尊重する", () => {
  withCleanVaultEnv((root) => {
    const explicitVault = path.join(root, "elsewhere", "vault");
    mkdirSync(explicitVault, { recursive: true });
    mkdirSync(path.join(root, ".graphrag", "vault"), { recursive: true });
    writeFileSync(path.join(root, ".graphrag", ".env"), `GRAPHRAG_VAULT_DIR=${explicitVault}\n`);
    discoverAndLoadGraphragEnv(root);
    bindClosestVaultDir(root);
    assert.equal(process.env.GRAPHRAG_VAULT_DIR, explicitVault);
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
