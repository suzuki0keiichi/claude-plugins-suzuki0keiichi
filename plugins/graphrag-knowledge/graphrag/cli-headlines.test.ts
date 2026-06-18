import assert from "node:assert/strict";
import test from "node:test";
import { parseFlagsArgv, shouldEscalate, runAsk, dispatchHeadline, dupAckFlag, parseOnOff, countBindingDebt } from "./cli-headlines.ts";
import http from "node:http";
import { buildVaultFiles } from "./build-vault.ts";
import { importVault } from "./import-vault.ts";
import { indexCodebase } from "./index-codebase.ts";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");

// 回帰 (CRITICAL): carve ヘッドラインの index 段は、単独 index verb と同じく正本 vault から
// 本物 File summary を継ぐ。以前 runCarve は resolvePreviousGraph を通らず vault を無視し、
// carve のたびに全 File summary を provisional に戻して再 author 済み要約を握り潰していた。
test("carve: index 段が vault の authored summary を継ぐ (provisional に戻さない)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "carve-root-"));
  const vaultDir = mkdtempSync(path.join(tmpdir(), "carve-vault-"));
  const stateDir = mkdtempSync(path.join(tmpdir(), "carve-state-"));
  const savedVaultEnv = process.env.GRAPHRAG_VAULT_DIR;
  delete process.env.GRAPHRAG_VAULT_DIR; // env 干渉排除 (--vault で明示)
  try {
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "core.ts"), `export function doThing(a: number) { return a + 1; }\n`);

    // 初回 index → vault を作り、core.ts に本物 summary を入れ provisional を外す。
    const first = indexCodebase({ root, systemName: "demo" });
    const coreId = first.nodes.find((n: any) => n.type === "File" && n.path.endsWith("core.ts")).id;
    const vaultGraph = {
      ...first,
      nodes: first.nodes.map((n: any) =>
        n.id === coreId ? { ...n, summary: "本物: 中核計算ロジック", summary_provisional: undefined } : n
      ),
    };
    for (const f of buildVaultFiles(vaultGraph)) {
      const abs = path.join(vaultDir, f.relPath);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
    }

    // carve 実行 (stage3 carving-check が候補 provisional で exit 1 する可能性 → 無視して
    // stage1 が書いた indexed-graph.json を読む)。
    try {
      execFileSync("node", ["--experimental-strip-types", CLI, "carve", "--root", root, "--system", "demo", "--vault", vaultDir], {
        encoding: "utf8",
        env: { ...process.env, GRAPHRAG_STATE_DIR: stateDir },
      });
    } catch {
      /* carving-check ERROR で exit 1 でも indexed-graph.json は書かれている */
    }

    const indexed = JSON.parse(readFileSync(path.join(stateDir, "indexed-graph.json"), "utf8"));
    const core = indexed.nodes.find((n: any) => n.id === coreId);
    assert.equal(core.summary, "本物: 中核計算ロジック", "carve が vault の authored summary を継ぐ");
    assert.notEqual(core.summary_provisional, true, "継いだ authored summary は provisional でない");
  } finally {
    if (savedVaultEnv === undefined) delete process.env.GRAPHRAG_VAULT_DIR;
    else process.env.GRAPHRAG_VAULT_DIR = savedVaultEnv;
    rmSync(root, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("runAsk passes --vault through to the read path (index-missing, not vault-missing)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "runask-"));
  const vaultDir = path.join(root, "v");
  for (const f of buildVaultFiles({
    nodes: [{ id: "decision:s:x", type: "Decision", title: "X" }], edges: []
  })) {
    const abs = path.join(vaultDir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  const prevVault = process.env.GRAPHRAG_VAULT_DIR;
  const prevState = process.env.GRAPHRAG_STATE_DIR;
  delete process.env.GRAPHRAG_VAULT_DIR;
  process.env.GRAPHRAG_STATE_DIR = path.join(root, "state");
  try {
    // env を設定せず --vault のみ。vault が伝わっていれば索引欠如エラー
    // (vault 未伝播なら "vault directory not specified" になる)。
    await assert.rejects(
      () => runAsk(["X", "--vault", vaultDir]),
      /vector index not found/
    );
  } finally {
    if (prevVault === undefined) delete process.env.GRAPHRAG_VAULT_DIR;
    else process.env.GRAPHRAG_VAULT_DIR = prevVault;
    if (prevState === undefined) delete process.env.GRAPHRAG_STATE_DIR;
    else process.env.GRAPHRAG_STATE_DIR = prevState;
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseFlagsArgv handles --flag value and --flag=value", () => {
  const out = parseFlagsArgv(["--system", "foo", "--slug=bar", "--title", "T"]);
  assert.equal(out.system, "foo");
  assert.equal(out.slug, "bar");
  assert.equal(out.title, "T");
});

test("parseFlagsArgv collects repeated --evidence into array", () => {
  const out = parseFlagsArgv(["--evidence", "file:foo:a.ts", "--evidence", "file:foo:b.ts"]);
  assert.deepEqual(out.evidence, ["file:foo:a.ts", "file:foo:b.ts"]);
});

test("parseFlagsArgv treats bare positional as _positional", () => {
  const out = parseFlagsArgv(["plan.json", "--dry-run"]);
  assert.deepEqual(out._positional, ["plan.json"]);
  assert.equal(out["dry-run"], true);
});

test("parseFlagsArgv handles trailing --flag without value as true", () => {
  const out = parseFlagsArgv(["--yes"]);
  assert.equal(out.yes, true);
});

test("parseFlagsArgv handles --flag1 value --flag2 (flag2 without value)", () => {
  const out = parseFlagsArgv(["--first", "v1", "--second"]);
  assert.equal(out.first, "v1");
  assert.equal(out.second, true);
});

test("shouldEscalate: brief high + results → no escalate", () => {
  assert.equal(shouldEscalate({ match_confidence: "high", result_count: 5 }), false);
});

test("shouldEscalate: brief low → escalate", () => {
  assert.equal(shouldEscalate({ match_confidence: "low", result_count: 1 }), true);
});

test("shouldEscalate: brief none → escalate", () => {
  assert.equal(shouldEscalate({ match_confidence: "none", result_count: 0 }), true);
});

test("shouldEscalate: brief high but zero results → escalate", () => {
  assert.equal(shouldEscalate({ match_confidence: "high", result_count: 0 }), true);
});

test("shouldEscalate: empty stage outcome → escalate (defaults to none/0)", () => {
  assert.equal(shouldEscalate({}), true);
});

// --- typed-add / commit-mutation: vault writer path (FalkorDB 非経由) ---

const FIXED_TS = "2026-01-01T00:00:00.000Z";

/**
 * git 初期化済みの seed vault を作る。(path 付き) File ノードを置く。
 * typed-add の Decision/OK/Risk は source-backing 必須なので、--evidence が
 * 指す File ノードを seed に含めておく必要がある。
 */
function gitInitVault(): { repo: string; vault: string; stateDir: string; fileEvidence: string } {
  const repo = mkdtempSync(path.join(tmpdir(), "clivault-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  const vault = path.join(repo, "vault");
  for (const f of buildVaultFiles({
    generated_at: FIXED_TS,
    nodes: [
      { id: "file:s:src/a.ts", type: "File", title: "a.ts", path: "src/a.ts" }
    ],
    edges: []
  })) {
    const abs = path.join(vault, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed"]);
  const stateDir = path.join(path.dirname(vault), ".graphrag");
  mkdirSync(stateDir, { recursive: true });
  return { repo, vault, stateDir, fileEvidence: "file:s:src/a.ts" };
}

function vaultHead(vault: string): string {
  return execFileSync("git", ["-C", vault, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

async function withVaultEnv<T>(vault: string, stateDir: string, fn: () => Promise<T>): Promise<T> {
  const prevVault = process.env.GRAPHRAG_VAULT_DIR;
  const prevState = process.env.GRAPHRAG_STATE_DIR;
  process.env.GRAPHRAG_VAULT_DIR = vault;
  process.env.GRAPHRAG_STATE_DIR = stateDir;
  // vault isolation: テスト用 vault の .graphrag/.env に mode を書く
  // (detectVaultIsolation は cwd の .graphrag/.env を "local" 扱いにする)
  const repo = path.dirname(vault);
  const graphragDir = path.join(repo, ".graphrag");
  mkdirSync(graphragDir, { recursive: true });
  const envPath = path.join(graphragDir, ".env");
  const envExisted = existsSync(envPath);
  const prevEnvContent = envExisted ? readFileSync(envPath, "utf8") : null;
  writeFileSync(envPath, "GRAPHRAG_VAULT_MODE=direct\n");
  const prevCwd = process.cwd();
  process.chdir(repo);
  // embedding endpoint は設定しない: 索引ビルドは非致命なので mutation は commit される。
  const prevEndpoint = process.env.GRAPHRAG_EMBEDDING_ENDPOINT;
  const prevProvider = process.env.GRAPHRAG_VECTOR_PROVIDER;
  delete process.env.GRAPHRAG_EMBEDDING_ENDPOINT;
  delete process.env.GRAPHRAG_VECTOR_PROVIDER;
  try {
    return await fn();
  } finally {
    process.chdir(prevCwd);
    if (prevEnvContent !== null) writeFileSync(envPath, prevEnvContent); else if (existsSync(envPath)) unlinkSync(envPath);
    if (prevVault === undefined) delete process.env.GRAPHRAG_VAULT_DIR; else process.env.GRAPHRAG_VAULT_DIR = prevVault;
    if (prevState === undefined) delete process.env.GRAPHRAG_STATE_DIR; else process.env.GRAPHRAG_STATE_DIR = prevState;
    if (prevEndpoint === undefined) delete process.env.GRAPHRAG_EMBEDDING_ENDPOINT; else process.env.GRAPHRAG_EMBEDDING_ENDPOINT = prevEndpoint;
    if (prevProvider === undefined) delete process.env.GRAPHRAG_VECTOR_PROVIDER; else process.env.GRAPHRAG_VECTOR_PROVIDER = prevProvider;
  }
}

test("add-decision: vault に書き込まれ git commit される (索引欠如は非致命)", async () => {
  const { repo, vault, stateDir, fileEvidence } = gitInitVault();
  try {
    const head0 = vaultHead(vault);
    await withVaultEnv(vault, stateDir, () =>
      dispatchHeadline("add-decision", [
        "--system", "s",
        "--slug", "wire",
        "--title", "Wire to vault",
        "--summary", "route typed-add through vault writer",
        "--evidence", fileEvidence
      ])
    );
    // node landed in vault (索引 endpoint 無しでも mutation は commit される)
    const imp = importVault(vault);
    assert.ok(imp.nodes.some((n) => n.id === "decision:s:wire"), "decision node written to vault");
    // git commit happened
    assert.notEqual(vaultHead(vault), head0, "HEAD should advance after add-decision");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("add-decision: GRAPHRAG_VAULT_DIR 未設定なら明確にエラー", async () => {
  const prevVault = process.env.GRAPHRAG_VAULT_DIR;
  delete process.env.GRAPHRAG_VAULT_DIR;
  try {
    await assert.rejects(
      () => dispatchHeadline("add-decision", [
        "--system", "s", "--slug", "x", "--title", "T", "--summary", "S"
      ]),
      /GRAPHRAG_VAULT_DIR/
    );
  } finally {
    if (prevVault === undefined) delete process.env.GRAPHRAG_VAULT_DIR; else process.env.GRAPHRAG_VAULT_DIR = prevVault;
  }
});

test("commit-mutation: plan.json を vault 経由で適用し commit される", async () => {
  const { repo, vault, stateDir, fileEvidence } = gitInitVault();
  const planPath = path.join(repo, "plan.json");
  writeFileSync(planPath, JSON.stringify({
    reason: "add decision via commit-mutation",
    nodes: [{ op: "create", id: "decision:s:cm", type: "Decision", title: "CM", summary: "cm" }],
    edges: [{
      op: "create",
      id: "decision_s_cm__documented_by__file_s_src_a.ts",
      type: "documented_by",
      from: "decision:s:cm",
      to: fileEvidence
    }]
  }));
  try {
    const head0 = vaultHead(vault);
    await withVaultEnv(vault, stateDir, () =>
      dispatchHeadline("commit-mutation", [planPath])
    );
    const imp = importVault(vault);
    assert.ok(imp.nodes.some((n) => n.id === "decision:s:cm"), "node written to vault");
    assert.notEqual(vaultHead(vault), head0, "HEAD should advance after commit-mutation");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dupAckFlag: カンマ区切りと反復指定の両方を id 配列に正規化", () => {
  assert.deepEqual(
    dupAckFlag(parseFlagsArgv(["--dup-ack", "a:s:1,b:s:2"])),
    ["a:s:1", "b:s:2"]
  );
  assert.deepEqual(
    dupAckFlag(parseFlagsArgv(["--dup-ack", "a:s:1", "--dup-ack", "b:s:2"])),
    ["a:s:1", "b:s:2"]
  );
});

test("dupAckFlag: 未指定は undefined (plan に空配列を撒かない)", () => {
  assert.equal(dupAckFlag(parseFlagsArgv([])), undefined);
  assert.equal(dupAckFlag(parseFlagsArgv(["--dup-ack", " , "])), undefined);
});

test("add-investigation: state 既定は active、--state closed で上書き", async () => {
  const { repo, vault, stateDir } = gitInitVault();
  try {
    await withVaultEnv(vault, stateDir, async () => {
      await dispatchHeadline("add-investigation", [
        "--system", "s", "--slug", "probe-a", "--title", "Probe A", "--summary", "調査A",
        "--raw-content", "生ログA"
      ]);
      await dispatchHeadline("add-investigation", [
        "--system", "s", "--slug", "probe-b", "--title", "Probe B", "--summary", "調査B",
        "--raw-content", "生ログB", "--state", "closed"
      ]);
    });
    const imp = importVault(vault);
    assert.equal(imp.nodes.find((n) => n.id === "investigation:s:probe-a")?.state, "active");
    assert.equal(imp.nodes.find((n) => n.id === "investigation:s:probe-b")?.state, "closed");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("add-investigation: 語彙外の --state は明確に拒否", async () => {
  const { repo, vault, stateDir } = gitInitVault();
  try {
    await withVaultEnv(vault, stateDir, () =>
      assert.rejects(
        () => dispatchHeadline("add-investigation", [
          "--system", "s", "--slug", "probe-x", "--title", "X", "--summary", "x",
          "--raw-content", "raw", "--state", "done"
        ]),
        /allowed: active, closed/
      )
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/** OpenAI 互換 embedding endpoint のモック。全入力に同一ベクトルを返す (= 類似度 1.0)。 */
function startEmbeddingMock(): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && (req.url ?? "").includes("/models")) {
        res.end(JSON.stringify({ data: [{ id: "nomic-embed-text" }] }));
        return;
      }
      req.resume();
      req.on("end", () => {
        res.end(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        base: `http://127.0.0.1:${addr.port}/v1`,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

// 契約 A1 の CLI 配線: 重複 suspect は --dup-ack なしで all-or-nothing 拒否、
// --dup-ack <existing-id> で plan.duplicate_ack に注入され通る。
test("add-decision: 重複 suspect は拒否され、--dup-ack で承認すると通る", async () => {
  const mock = await startEmbeddingMock();
  const { repo, vault, stateDir, fileEvidence } = gitInitVault();
  // 既存の同型ノード (Decision) + その索引行を仕込む (モックは全て同一ベクトル → 類似度 1.0)
  for (const f of buildVaultFiles({
    generated_at: FIXED_TS,
    nodes: [
      { id: "file:s:src/a.ts", type: "File", title: "a.ts", path: "src/a.ts" },
      { id: "decision:s:old", type: "Decision", title: "Wire to vault", summary: "route typed-add through vault writer" }
    ],
    edges: []
  })) {
    const abs = path.join(vault, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed decision"]);
  writeFileSync(path.join(stateDir, "vector.json"), JSON.stringify({
    version: 1,
    provider: "openai-compatible-embedding",
    provider_capability: "semantic",
    semantic: true,
    dimensions: 2,
    provider_options: { endpoint: `${mock.base}/embeddings`, model: "nomic-embed-text" },
    rows: [{ node_id: "decision:s:old", dimensions: 2, vector: [1, 0], text_hash: "seed" }]
  }));
  // vault isolation: テスト用 vault の .graphrag/.env に mode を書き、cwd を vault repo に変更
  writeFileSync(path.join(stateDir, ".env"), "GRAPHRAG_VAULT_MODE=direct\n");
  const prevCwd = process.cwd();
  process.chdir(repo);
  const prevEnv = {
    GRAPHRAG_VAULT_DIR: process.env.GRAPHRAG_VAULT_DIR,
    GRAPHRAG_STATE_DIR: process.env.GRAPHRAG_STATE_DIR,
    GRAPHRAG_EMBEDDING_ENDPOINT: process.env.GRAPHRAG_EMBEDDING_ENDPOINT
  };
  process.env.GRAPHRAG_VAULT_DIR = vault;
  process.env.GRAPHRAG_STATE_DIR = stateDir;
  process.env.GRAPHRAG_EMBEDDING_ENDPOINT = `${mock.base}/embeddings`;
  try {
    const addArgs = [
      "--system", "s", "--slug", "new",
      "--title", "Wire to vault (again)", "--summary", "route typed-add through the vault writer",
      "--evidence", fileEvidence
    ];
    await assert.rejects(
      () => dispatchHeadline("add-decision", addArgs),
      /duplicate-suspect/
    );
    assert.ok(!importVault(vault).nodes.some((n) => n.id === "decision:s:new"), "拒否時は何も書かれない");

    await dispatchHeadline("add-decision", [...addArgs, "--dup-ack", "decision:s:old"]);
    assert.ok(importVault(vault).nodes.some((n) => n.id === "decision:s:new"), "--dup-ack で承認すると書ける");
  } finally {
    process.chdir(prevCwd);
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(repo, { recursive: true, force: true });
    await mock.close();
  }
});

// 契約: carve は vector index 不在を検知すると index 段の成果から自動構築して suggest 系へ進む。
test("carve: vector index 不在なら自動構築して進む (endpoint 到達時)", async () => {
  const mock = await startEmbeddingMock();
  const root = mkdtempSync(path.join(tmpdir(), "carve-auto-"));
  const stateDir = mkdtempSync(path.join(tmpdir(), "carve-auto-state-"));
  const savedVaultEnv = process.env.GRAPHRAG_VAULT_DIR;
  delete process.env.GRAPHRAG_VAULT_DIR;
  try {
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "core.ts"), `export const one = 1;\n`);
    // 同期 exec はテストプロセスの event loop を塞ぎ、モック endpoint が応答できなくなる
    // → 非同期 execFile で待つ。concern-hint が provisional 拒否で exit 1 しても
    // 索引自体は構築済みなので exit code は見ない。
    await new Promise<void>((resolve) => {
      execFile("node", ["--experimental-strip-types", CLI, "carve", "--root", root, "--system", "demo"], {
        encoding: "utf8",
        env: {
          ...process.env,
          GRAPHRAG_STATE_DIR: stateDir,
          GRAPHRAG_EMBEDDING_ENDPOINT: `${mock.base}/embeddings`
        }
      }, () => resolve());
    });
    assert.ok(
      readFileSync(path.join(stateDir, "vector-index.json"), "utf8").includes("openai-compatible-embedding"),
      "carve が vector index を自動構築する"
    );
  } finally {
    if (savedVaultEnv === undefined) delete process.env.GRAPHRAG_VAULT_DIR;
    else process.env.GRAPHRAG_VAULT_DIR = savedVaultEnv;
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    await mock.close();
  }
});

// --- E1/E2/R3 typed-add 新 verb / 新フラグの配線 ---

test("parseOnOff: on|off|未指定を boolean/undefined に正規化", () => {
  assert.equal(parseOnOff("off"), false);
  assert.equal(parseOnOff("OFF"), false);
  assert.equal(parseOnOff("false"), false);
  assert.equal(parseOnOff("on"), true);
  assert.equal(parseOnOff("true"), true);
  assert.equal(parseOnOff(undefined), undefined);
});

test("add-constraint: Constraint ノード + constrains エッジを書く (documented_by 無し)", async () => {
  const { repo, vault, stateDir } = gitInitVault();
  try {
    await withVaultEnv(vault, stateDir, () =>
      dispatchHeadline("add-constraint", [
        "--system", "s", "--slug", "no-npm",
        "--title", "npm 禁止", "--summary", "pnpm 一択",
        "--constrains", "file:s:src/a.ts",
        "--aliases", "no npm,pnpm only"
      ])
    );
    const imp = importVault(vault);
    const node = imp.nodes.find((n) => n.id === "constraint:s:no-npm");
    assert.ok(node, "constraint node written");
    assert.deepEqual(node.aliases, ["no npm", "pnpm only"], "aliases 配線");
    assert.ok(
      imp.edges.some((e) => e.type === "constrains" && e.from === "constraint:s:no-npm" && e.to === "file:s:src/a.ts"),
      "constrains edge written"
    );
    assert.ok(
      !imp.edges.some((e) => e.type === "documented_by" && e.from === "constraint:s:no-npm"),
      "Constraint は documented_by を張らない"
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("add-constraint: --constrains 不足は明確にエラー (孤児防止)", async () => {
  const { repo, vault, stateDir } = gitInitVault();
  try {
    await withVaultEnv(vault, stateDir, () =>
      assert.rejects(
        () => dispatchHeadline("add-constraint", [
          "--system", "s", "--slug", "x", "--title", "X", "--summary", "x"
        ]),
        /--constrains/
      )
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("add-goal: Goal ノード + --state / --refines を書く", async () => {
  const { repo, vault, stateDir } = gitInitVault();
  try {
    await withVaultEnv(vault, stateDir, async () => {
      await dispatchHeadline("add-goal", [
        "--system", "s", "--slug", "parent", "--title", "親ゴール", "--summary", "上位目的",
        "--state", "active"
      ]);
      await dispatchHeadline("add-goal", [
        "--system", "s", "--slug", "child", "--title", "子ゴール", "--summary", "下位目的",
        "--refines", "goal:s:parent"
      ]);
    });
    const imp = importVault(vault);
    assert.equal(imp.nodes.find((n) => n.id === "goal:s:parent")?.state, "active");
    assert.equal(imp.nodes.find((n) => n.id === "goal:s:child")?.state ?? null, null, "state 未指定なら付かない");
    assert.ok(
      imp.edges.some((e) => e.type === "refines" && e.from === "goal:s:child" && e.to === "goal:s:parent"),
      "refines edge written"
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("add-goal: 語彙外の --state は明確に拒否", async () => {
  const { repo, vault, stateDir } = gitInitVault();
  try {
    await withVaultEnv(vault, stateDir, () =>
      assert.rejects(
        () => dispatchHeadline("add-goal", [
          "--system", "s", "--slug", "x", "--title", "X", "--summary", "x", "--state", "done"
        ]),
        /allowed: planned, active, achieved, abandoned/
      )
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("add-decision: --sets-policy-for / --premise の新エッジフラグが透過する", async () => {
  const { repo, vault, stateDir, fileEvidence } = gitInitVault();
  try {
    await withVaultEnv(vault, stateDir, async () => {
      // premise 先の Decision を先に書く
      await dispatchHeadline("add-decision", [
        "--system", "s", "--slug", "base", "--title", "Base", "--summary", "前提決定",
        "--evidence", fileEvidence
      ]);
      await dispatchHeadline("add-decision", [
        "--system", "s", "--slug", "lead", "--title", "Lead", "--summary", "方針",
        "--evidence", fileEvidence,
        "--sets-policy-for", fileEvidence,
        "--premise", "decision:s:base"
      ]);
    });
    const imp = importVault(vault);
    assert.ok(
      imp.edges.some((e) => e.type === "sets_policy_for" && e.from === "decision:s:lead" && e.to === fileEvidence),
      "sets_policy_for edge written"
    );
    assert.ok(
      imp.edges.some((e) => e.type === "has_premise" && e.from === "decision:s:lead" && e.to === "decision:s:base"),
      "has_premise edge written"
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("add-decision: 文法違反の --sets-policy-for 宛先は黙って落とさず throw", async () => {
  const { repo, vault, stateDir, fileEvidence } = gitInitVault();
  try {
    await withVaultEnv(vault, stateDir, () =>
      assert.rejects(
        // sets_policy_for の宛先に Risk は不正
        () => dispatchHeadline("add-decision", [
          "--system", "s", "--slug", "bad", "--title", "B", "--summary", "b",
          "--evidence", fileEvidence,
          "--sets-policy-for", "risk:s:whatever"
        ]),
        /sets_policy_for/
      )
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("countBindingDebt: bind 無し knowledge ノードを数える (Constraint 拡張含む)", () => {
  const graph = {
    nodes: [
      { id: "decision:s:bound", type: "Decision" },
      { id: "decision:s:orphan", type: "Decision" },
      { id: "constraint:s:bound", type: "Constraint" },
      { id: "constraint:s:orphan", type: "Constraint" },
      { id: "file:s:a", type: "File" }
    ],
    edges: [
      { type: "sets_policy_for", from: "decision:s:bound", to: "file:s:a" },
      { type: "constrains", from: "constraint:s:bound", to: "file:s:a" }
    ]
  };
  // orphan Decision 1 + orphan Constraint 1 = 2
  assert.equal(countBindingDebt(graph), 2);
});

test("commit-mutation: --base-sha が現 HEAD と違えば OCC で拒否", async () => {
  const { repo, vault, stateDir, fileEvidence } = gitInitVault();
  const planPath = path.join(repo, "plan.json");
  writeFileSync(planPath, JSON.stringify({
    reason: "stale plan",
    nodes: [{ op: "create", id: "decision:s:stale", type: "Decision", title: "St", summary: "st" }],
    edges: [{
      op: "create",
      id: "decision_s_stale__documented_by__file_s_src_a.ts",
      type: "documented_by",
      from: "decision:s:stale",
      to: fileEvidence
    }]
  }));
  try {
    await withVaultEnv(vault, stateDir, () =>
      assert.rejects(
        () => dispatchHeadline("commit-mutation", [planPath, "--base-sha", "deadbeef"]),
        /stale|OCC|base/i
      )
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
