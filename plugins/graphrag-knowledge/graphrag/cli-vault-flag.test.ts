// issue #44: --vault は verb を問わず runCli で一度だけ解決され、既定 vault に黙って書かない。
// graphrag:enforces constraint:graphrag-skill-dev:vault-flag-single-interpretation — --vault は全 verb で launcher と同じ1つの vault を指す
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseVaultFlag, normalizeVaultArgv, bindCliVaultDir, getVaultDirSource, resetVaultDirSourceForTest } from "./cli-env.ts";
import { buildVaultFiles } from "./build-vault.ts";
import { importVault } from "./import-vault.ts";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");

test("parseVaultFlag: 空白区切り / = 形式 / 相対 path の cwd 基準絶対化", () => {
  assert.deepEqual(parseVaultFlag(["x", "--vault", "v"], "/w"), { vaultDir: "/w/v" });
  assert.deepEqual(parseVaultFlag(["--vault=/abs/v"], "/w"), { vaultDir: "/abs/v" });
  assert.deepEqual(parseVaultFlag(["--mode", "resume"], "/w"), {});
});

test("parseVaultFlag: 値欠落・値位置に別 flag・重複は error", () => {
  assert.ok(parseVaultFlag(["--vault"]).error);
  assert.ok(parseVaultFlag(["--vault="]).error);
  assert.ok(parseVaultFlag(["--vault", "--mode", "resume"]).error);
  assert.ok(parseVaultFlag(["--vault", "a", "--vault=a"]).error);
});

test("bindCliVaultDir: env と source を焼き、restore で元に戻す", () => {
  const prev = process.env.GRAPHRAG_VAULT_DIR;
  process.env.GRAPHRAG_VAULT_DIR = "/before";
  resetVaultDirSourceForTest();
  try {
    const restore = bindCliVaultDir("/cli");
    assert.equal(process.env.GRAPHRAG_VAULT_DIR, "/cli");
    assert.equal(getVaultDirSource(), "cli-arg");
    restore();
    assert.equal(process.env.GRAPHRAG_VAULT_DIR, "/before");
    assert.equal(getVaultDirSource(), null);
  } finally {
    if (prev === undefined) delete process.env.GRAPHRAG_VAULT_DIR; else process.env.GRAPHRAG_VAULT_DIR = prev;
  }
});

function makeVault(root: string, nodeId: string): string {
  const vault = path.join(root, "vault");
  for (const f of buildVaultFiles({
    generated_at: "2026-01-01T00:00:00.000Z",
    nodes: [{ id: nodeId, type: "File", title: "a.ts", path: "src/a.ts" }],
    edges: []
  })) {
    const abs = path.join(vault, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return vault;
}

const head = (dir: string) => execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

/** cwd=A (既定 vault を .graphrag/.env で A に向ける)、B は別 repo。 */
function setup(mode: string) {
  const tmp = mkdtempSync(path.join(tmpdir(), "vaultflag-"));
  const repoA = path.join(tmp, "a");
  const repoB = path.join(tmp, "b");
  mkdirSync(repoA); mkdirSync(repoB);
  const vaultA = makeVault(repoA, "file:s:src/a.ts");
  const vaultB = makeVault(repoB, "file:s:src/a.ts");
  mkdirSync(path.join(repoA, ".graphrag"));
  writeFileSync(path.join(repoA, ".graphrag", ".env"), `GRAPHRAG_VAULT_DIR=${vaultA}\nGRAPHRAG_VAULT_MODE=${mode}\n`);
  const planPath = path.join(tmp, "plan.json");
  writeFileSync(planPath, JSON.stringify({
    reason: "create-only plan",
    nodes: [{ op: "create", id: "decision:s:vf", type: "Decision", title: "VF", summary: "vf" }],
    edges: [{ op: "create", id: "e_vf", type: "documented_by", from: "decision:s:vf", to: "file:s:src/a.ts" }]
  }));
  const run = (args: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmp, GRAPHRAG_EMBEDDING_ENDPOINT: "http://127.0.0.1:9/v1" };
    delete env.GRAPHRAG_VAULT_DIR;
    delete env.GRAPHRAG_VAULT_MODE;
    delete env.GRAPHRAG_VECTOR_PROVIDER;
    return spawnSync("node", ["--experimental-strip-types", CLI, ...args], { cwd: repoA, env, encoding: "utf8" });
  };
  return { tmp, repoA, repoB, vaultA, vaultB, planPath, run };
}

test("commit-mutation --vault B: create-only plan は B に書かれ、既定 vault A は不変", () => {
  const s = setup("direct");
  try {
    const headA = head(s.repoA);
    const headB = head(s.repoB);
    const r = s.run(["commit-mutation", s.planPath, "--vault", s.vaultB]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`vault: ${s.vaultB} \\(source: cli-arg\\)`));
    assert.ok(importVault(s.vaultB).nodes.some((n) => n.id === "decision:s:vf"));
    assert.ok(!importVault(s.vaultA).nodes.some((n) => n.id === "decision:s:vf"));
    assert.equal(head(s.repoA), headA);
    assert.notEqual(head(s.repoB), headB);
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("commit-mutation --vault B: cwd の readonly mode は --vault 経由でも書き込みを拒否する", () => {
  const s = setup("readonly");
  try {
    const headB = head(s.repoB);
    const r = s.run(["commit-mutation", s.planPath, "--vault", s.vaultB]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /readonly/);
    assert.equal(head(s.repoB), headB);
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("brief / inspect は --vault B を参照する。--graph と食い違えば exit 2", () => {
  const s = setup("direct");
  try {
    const brief = s.run(["brief", "--mode", "resume", "--vault", s.vaultB]);
    assert.equal(brief.status, 0, brief.stderr);
    assert.equal(JSON.parse(brief.stdout).graph.source, s.vaultB);
    const inspect = s.run(["inspect", "--vault", s.vaultB]);
    assert.equal(inspect.status, 0, inspect.stderr);
    assert.match(inspect.stdout, new RegExp(s.vaultB));
    const same = s.run(["brief", "--mode", "resume", "--vault", s.vaultB, "--graph", s.vaultB]);
    assert.equal(same.status, 0, same.stderr);
    const conflict = s.run(["brief", "--mode", "resume", "--vault", s.vaultB, "--graph", s.vaultA]);
    assert.equal(conflict.status, 2);
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("--vault の値欠落は verb 実行前に exit 2", () => {
  const s = setup("direct");
  try {
    const headA = head(s.repoA);
    const r = s.run(["commit-mutation", s.planPath, "--vault"]);
    assert.equal(r.status, 2);
    assert.equal(head(s.repoA), headA);
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("normalizeVaultArgv: 全形式をその位置で `--vault <abs>` に揃える / strip は除去", () => {
  assert.deepEqual(normalizeVaultArgv(["--vault=v", "id"], "/abs", false), ["--vault", "/abs", "id"]);
  assert.deepEqual(normalizeVaultArgv(["--root", "r", "--vault", "v"], "/abs", false), ["--root", "r", "--vault", "/abs"]);
  assert.deepEqual(normalizeVaultArgv(["--vault", "v", "out.json"], "/abs", true), ["out.json"]);
});

test("verb 側の再解析も launcher と同じ vault を見る (show --vault= / vault-import --vault)", () => {
  const s = setup("direct");
  try {
    const show = s.run(["show", "--vault=" + s.vaultB, "file:s:src/a.ts"]);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /file:s:src\/a\.ts/);
    const imp = s.run(["vault-import", "--vault", s.vaultB]);
    assert.equal(imp.status, 0, imp.stderr);
    assert.ok(JSON.parse(imp.stdout).nodes.some((n: any) => n.id === "file:s:src/a.ts"));
  } finally {
    rmSync(s.tmp, { recursive: true, force: true });
  }
});
