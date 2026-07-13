import assert from "node:assert/strict";
import test from "node:test";
import { parseFlagsArgv, shouldEscalate, runAsk, dispatchHeadline, dupAckFlag, parseOnOff, countBindingDebt, ensureEvidenceFileNodes } from "./cli-headlines.ts";
import { consumerCacheDirForVault } from "./cli-env.ts";
import http from "node:http";
import { buildVaultFiles } from "./build-vault.ts";
import { importVault } from "./import-vault.ts";
import { indexCodebase } from "./index-codebase.ts";
import { execFile, execFileSync, spawnSync } from "node:child_process";
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

    // E1: carve 成果物は GRAPHRAG_STATE_DIR の cache/ 配下に置かれる。
    const indexed = JSON.parse(readFileSync(path.join(stateDir, "cache", "indexed-graph.json"), "utf8"));
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

// #3 回帰: 親 repo で readonly を宣言していても、実行中の worktree サブディレクトリに
// ローカルの .graphrag/.env が無ければ mode_source は "inherited" になり demote される
// (isolation.mode は null)。raw_mode でルーティングすることで、ask-state はそれでも
// 消費側 cache に書かれ、外部 vault 側は一切汚さない。
test("runAsk: 外部 vault + inherited readonly (worktree) では ask-state を消費側 cache に書く", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ask-ro-parent-"));
  const ext = mkdtempSync(path.join(tmpdir(), "ask-ro-ext-"));
  execFileSync("git", ["-C", parent, "init", "-q"]);
  execFileSync("git", ["-C", ext, "init", "-q"]);
  const vaultDir = path.join(ext, "vault");
  for (const f of buildVaultFiles({
    nodes: [{ id: "decision:s:x", type: "Decision", title: "X" }], edges: []
  })) {
    const abs = path.join(vaultDir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  mkdirSync(path.join(parent, ".graphrag"), { recursive: true });
  const worktreeSub = path.join(parent, "sub", "dir");
  mkdirSync(worktreeSub, { recursive: true });

  const prevCwd = process.cwd();
  const prevVault = process.env.GRAPHRAG_VAULT_DIR;
  const prevState = process.env.GRAPHRAG_STATE_DIR;
  const prevMode = process.env.GRAPHRAG_VAULT_MODE;
  delete process.env.GRAPHRAG_VAULT_DIR;
  delete process.env.GRAPHRAG_STATE_DIR;
  // 親 .graphrag/.env の継承結果を process.env で模す (discoverAndLoadGraphragEnv がやること)。
  process.env.GRAPHRAG_VAULT_MODE = "readonly";
  process.chdir(worktreeSub);
  try {
    try {
      await runAsk(["X", "--vault", vaultDir]);
    } catch {
      // semantic index 不在 (embedding endpoint 未設定) で最終的に失敗しても、
      // ask-state への書き込みは vector index を読む前に先に起きている。
    }

    const consumerDir = consumerCacheDirForVault(vaultDir, worktreeSub)!;
    assert.ok(
      existsSync(path.join(consumerDir, "ask-state.json")),
      "inherited readonly でも消費側 cache に ask-state を書く"
    );
    assert.ok(!existsSync(path.join(ext, ".graphrag")), "外部 vault 側には何も作らない");
  } finally {
    process.chdir(prevCwd);
    if (prevVault === undefined) delete process.env.GRAPHRAG_VAULT_DIR;
    else process.env.GRAPHRAG_VAULT_DIR = prevVault;
    if (prevState === undefined) delete process.env.GRAPHRAG_STATE_DIR;
    else process.env.GRAPHRAG_STATE_DIR = prevState;
    if (prevMode === undefined) delete process.env.GRAPHRAG_VAULT_MODE;
    else process.env.GRAPHRAG_VAULT_MODE = prevMode;
    rmSync(parent, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
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

test("commit-mutation: GRAPHRAG_VAULT_MODE=readonly は書き込みを拒否する (write guard 一元化)", async () => {
  const { repo, vault, stateDir, fileEvidence } = gitInitVault();
  const planPath = path.join(repo, "plan.json");
  writeFileSync(planPath, JSON.stringify({
    reason: "must be blocked",
    nodes: [{ op: "create", id: "decision:s:ro", type: "Decision", title: "RO", summary: "ro" }],
    edges: [{
      op: "create",
      id: "decision_s_ro__documented_by__file_s_src_a.ts",
      type: "documented_by",
      from: "decision:s:ro",
      to: fileEvidence
    }]
  }));
  const prevVault = process.env.GRAPHRAG_VAULT_DIR;
  const prevState = process.env.GRAPHRAG_STATE_DIR;
  const prevCwd = process.cwd();
  process.env.GRAPHRAG_VAULT_DIR = vault;
  process.env.GRAPHRAG_STATE_DIR = stateDir;
  writeFileSync(path.join(stateDir, ".env"), "GRAPHRAG_VAULT_MODE=readonly\n");
  process.chdir(repo);
  try {
    const head0 = vaultHead(vault);
    await assert.rejects(
      () => dispatchHeadline("commit-mutation", [planPath]),
      /readonly/
    );
    assert.equal(vaultHead(vault), head0, "readonly 下では HEAD が動かない");
    assert.ok(!importVault(vault).nodes.some((n) => n.id === "decision:s:ro"), "何も書かれない");
  } finally {
    process.chdir(prevCwd);
    if (prevVault === undefined) delete process.env.GRAPHRAG_VAULT_DIR; else process.env.GRAPHRAG_VAULT_DIR = prevVault;
    if (prevState === undefined) delete process.env.GRAPHRAG_STATE_DIR; else process.env.GRAPHRAG_STATE_DIR = prevState;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ask: vault 未解決なら state に触れる前に失敗し、cwd に .graphrag を作らない", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "askless-"));
  const fakeHome = mkdtempSync(path.join(tmpdir(), "askless-home-"));
  // subprocess で本物の CLI を叩く (env 読み込みシーケンス込みで検証する)。
  // HOME を空 tmp に差し替えて ~/.graphrag/.env の漏れ込みを遮断する (hermetic)。
  const env: Record<string, string | undefined> = { ...process.env, HOME: fakeHome };
  delete env.GRAPHRAG_VAULT_DIR;
  delete env.GRAPHRAG_STATE_DIR;
  delete env.GRAPHRAG_VAULT_MODE;
  try {
    const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile("node", ["--experimental-strip-types", CLI, "ask", "何か知ってる?"], {
        cwd, env: env as NodeJS.ProcessEnv, encoding: "utf8"
      }, (err, _stdout, stderrOut) => {
        resolve({ code: err ? ((err as any).code ?? 1) : 0, stderr: String(stderrOut) });
      });
    });
    assert.notEqual(code, 0, "vault 無しの ask は失敗する");
    assert.match(stderr, /vault/i, "vault が要る旨のエラーを出す");
    assert.ok(!existsSync(path.join(cwd, ".graphrag")), "ゴミ .graphrag を cwd に作らない");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("inspect: vault 未設定でも落ちず、state_dir / ask_state / indexed_graph を報告する", async () => {
  const prevVault = process.env.GRAPHRAG_VAULT_DIR;
  const prevState = process.env.GRAPHRAG_STATE_DIR;
  delete process.env.GRAPHRAG_VAULT_DIR;
  delete process.env.GRAPHRAG_STATE_DIR;
  let out = "";
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (chunk: any) => { out += String(chunk); return true; };
  try {
    await dispatchHeadline("inspect", []);
  } finally {
    (process.stdout as any).write = origWrite;
    if (prevVault === undefined) delete process.env.GRAPHRAG_VAULT_DIR; else process.env.GRAPHRAG_VAULT_DIR = prevVault;
    if (prevState === undefined) delete process.env.GRAPHRAG_STATE_DIR; else process.env.GRAPHRAG_STATE_DIR = prevState;
  }
  const parsed = JSON.parse(out);
  assert.equal(parsed.env.GRAPHRAG_VAULT_DIR, null);
  assert.ok("vault_dir_source" in parsed, "vault 解決の出所を報告する");
  assert.ok("state_dir" in parsed, "解決した state dir を報告する");
  assert.ok("ask_state" in parsed.artifacts, "ask-state の所在を報告する");
  assert.ok("indexed_graph" in parsed.artifacts, "indexed-graph の所在を報告する");
});

test("inspect: vector_index は実際の既定 (vault の cache/vector.json) を報告する", async () => {
  const { repo, vault, stateDir } = gitInitVault();
  const prevVault = process.env.GRAPHRAG_VAULT_DIR;
  const prevState = process.env.GRAPHRAG_STATE_DIR;
  const prevVec = process.env.GRAPHRAG_VECTOR_INDEX_PATH;
  process.env.GRAPHRAG_VAULT_DIR = vault;
  delete process.env.GRAPHRAG_STATE_DIR;
  delete process.env.GRAPHRAG_VECTOR_INDEX_PATH;
  let out = "";
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (chunk: any) => { out += String(chunk); return true; };
  try {
    await dispatchHeadline("inspect", []);
  } finally {
    (process.stdout as any).write = origWrite;
    if (prevVault === undefined) delete process.env.GRAPHRAG_VAULT_DIR; else process.env.GRAPHRAG_VAULT_DIR = prevVault;
    if (prevState === undefined) delete process.env.GRAPHRAG_STATE_DIR; else process.env.GRAPHRAG_STATE_DIR = prevState;
    if (prevVec === undefined) delete process.env.GRAPHRAG_VECTOR_INDEX_PATH; else process.env.GRAPHRAG_VECTOR_INDEX_PATH = prevVec;
    rmSync(repo, { recursive: true, force: true });
  }
  const parsed = JSON.parse(out);
  // 以前は graph_json の隣しか見ず zero-config で null を返す「嘘」だった。
  // 実際に読み書きが使う既定 (.graphrag/cache/vector.json) を報告すること。
  assert.equal(
    parsed.artifacts.vector_index.path,
    path.join(stateDir, "cache", "vector.json")
  );
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
  // E4 decoy: vault 索引の env を指しても carve のコードグラフ索引はここへ書かれてはならない。
  const decoyVaultIndex = path.join(stateDir, "decoy-vault-vector.json");
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
          GRAPHRAG_VECTOR_INDEX_PATH: decoyVaultIndex,
          GRAPHRAG_EMBEDDING_ENDPOINT: `${mock.base}/embeddings`,
          // Pin the model the mock serves. The carve subprocess boots the full CLI,
          // which reads ~/.graphrag/.env (the env-wide global fallback). On a machine
          // whose ~/.graphrag/.env sets GRAPHRAG_EMBEDDING_MODEL to a non-nomic model,
          // that model would leak in and the mock's /models (nomic-embed-text only)
          // would be rejected. Setting it here keeps the test hermetic (env wins over
          // ~/.graphrag/.env, which is read at lowest priority).
          GRAPHRAG_EMBEDDING_MODEL: "nomic-embed-text"
        }
      }, () => resolve());
    });
    assert.ok(
      readFileSync(path.join(stateDir, "cache", "vector-index.json"), "utf8").includes("openai-compatible-embedding"),
      "carve が vector index を自動構築する (E1: cache/ 配下)"
    );
    // E4: GRAPHRAG_VECTOR_INDEX_PATH は vault 索引専用で、carve は読まない
    // (decoy を設定して起動している)。decoy 先に書かれていたら vault 索引を潰す退行。
    assert.ok(!existsSync(decoyVaultIndex), "carve は GRAPHRAG_VECTOR_INDEX_PATH に書かない");
  } finally {
    if (savedVaultEnv === undefined) delete process.env.GRAPHRAG_VAULT_DIR;
    else process.env.GRAPHRAG_VAULT_DIR = savedVaultEnv;
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    await mock.close();
  }
});

// #8 回帰: carve の vector index 読みは E1 移行前の legacy 位置 (<root>/.graphrag/vector-index.json)
// にもフォールバックする。無いと、アップグレード後に事前構築済みの索引が無視され、
// endpoint 不達でなくても毎回コードベース全体の再 embed を強制していた。
test("carve: cache/ に vector-index.json が無ければ legacy (.graphrag 直下) を読み、再構築しない", () => {
  const root = mkdtempSync(path.join(tmpdir(), "carve-legacy-"));
  const stateDir = mkdtempSync(path.join(tmpdir(), "carve-legacy-state-"));
  const savedVaultEnv = process.env.GRAPHRAG_VAULT_DIR;
  delete process.env.GRAPHRAG_VAULT_DIR;
  try {
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "core.ts"), `export const one = 1;\n`);

    // legacy 位置 (stateDir 直下、cache/ 移行前) に事前構築済み索引を置く。
    // embedding endpoint は設定しない: legacy が拾われなければ自動構築が
    // endpoint 不達で失敗し stage 2/3 が SKIPPED になる。
    writeFileSync(
      path.join(stateDir, "vector-index.json"),
      JSON.stringify({ version: 1, provider: "legacy-carve-marker", semantic: false, rows: [] })
    );

    const result = spawnSync("node", ["--experimental-strip-types", CLI, "carve", "--root", root, "--system", "demo"], {
      encoding: "utf8",
      env: { ...process.env, GRAPHRAG_STATE_DIR: stateDir },
    });
    const stderr = result.stderr ?? "";

    assert.ok(!/vector index not found/.test(stderr), "legacy 索引を見つけたので自動構築を試みない");
    assert.ok(!/SKIPPED/.test(stderr), "自動構築 SKIPPED にならない (legacy を読めている)");
    assert.ok(!existsSync(path.join(stateDir, "cache", "vector-index.json")), "legacy を読めれば cache/ に新規で書かない");
  } finally {
    if (savedVaultEnv === undefined) delete process.env.GRAPHRAG_VAULT_DIR;
    else process.env.GRAPHRAG_VAULT_DIR = savedVaultEnv;
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
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
        "--aliases", "no npm,pnpm only",
        "--unenforceable", "lockfile 検査は未整備 (外部条件扱いの例)"
      ])
    );
    const imp = importVault(vault);
    const node = imp.nodes.find((n) => n.id === "constraint:s:no-npm");
    assert.ok(node, "constraint node written");
    assert.deepEqual(node.aliases, ["no npm", "pnpm only"], "aliases 配線");
    assert.equal(node.enforcement, "none", "enforcement:none が実 vault を round-trip する");
    assert.equal(node.enforcement_reason, "lockfile 検査は未整備 (外部条件扱いの例)");
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

test("add-constraint: --enforced-by は enforced_by エッジ + File 自動作成で実 vault に書ける", async () => {
  const { repo, vault, stateDir } = gitInitVault();
  try {
    // enforcer 検査ファイルを repo に実在させる (auto-create の disk 実在ガードを通す)
    mkdirSync(path.join(repo, "test"), { recursive: true });
    writeFileSync(path.join(repo, "test", "no-npm.test.ts"), "test(\"lockfile\", () => {});\n");
    await withVaultEnv(vault, stateDir, () =>
      dispatchHeadline("add-constraint", [
        "--system", "s", "--slug", "no-npm",
        "--title", "npm 禁止", "--summary", "pnpm 一択",
        "--constrains", "file:s:src/a.ts",
        "--enforced-by", "file:s:test/no-npm.test.ts"
      ])
    );
    const imp = importVault(vault);
    const node = imp.nodes.find((n) => n.id === "constraint:s:no-npm");
    assert.ok(node, "constraint node written");
    assert.ok(!("enforcement" in node), "enforcer 有りのとき enforcement:none を撒かない");
    assert.ok(
      imp.edges.some((e) => e.type === "enforced_by" && e.from === "constraint:s:no-npm" && e.to === "file:s:test/no-npm.test.ts"),
      "enforced_by edge written"
    );
    assert.ok(
      imp.nodes.some((n) => n.id === "file:s:test/no-npm.test.ts" && n.path === "test/no-npm.test.ts"),
      "enforcer File node auto-created"
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("add-constraint: enforcement 未選択は両方の処方を示して拒否 / 値なし --unenforceable も明示エラー", async () => {
  const { repo, vault, stateDir } = gitInitVault();
  try {
    await withVaultEnv(vault, stateDir, async () => {
      await assert.rejects(
        () => dispatchHeadline("add-constraint", [
          "--system", "s", "--slug", "x", "--title", "X", "--summary", "x",
          "--constrains", "file:s:src/a.ts"
        ]),
        (e: any) => /--enforced-by/.test(e.message) && /--unenforceable/.test(e.message)
      );
      await assert.rejects(
        () => dispatchHeadline("add-constraint", [
          "--system", "s", "--slug", "x", "--title", "X", "--summary", "x",
          "--constrains", "file:s:src/a.ts", "--unenforceable"
        ]),
        /--unenforceable requires a reason/
      );
    });
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

// ── E8: typed-add --evidence の File ノード自動作成 (write-back 摩擦の解消) ────

test("ensureEvidenceFileNodes: vault に無い File はディスク実在時に plan へ自動追加", () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "evroot-"));
  try {
    mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    writeFileSync(path.join(repoRoot, "src", "new.ts"), "export const x = 1;\n");
    const plan: any = {
      nodes: [{ op: "create", id: "decision:s:d", type: "Decision", title: "D", summary: "d" }],
      edges: [{ op: "create", id: "e1", type: "documented_by", from: "decision:s:d", to: "file:s:src/new.ts" }],
    };
    const created = ensureEvidenceFileNodes(plan, "/unused", {
      loadGraph: () => ({ nodes: [] }),
      repoRoot,
    });
    assert.deepEqual(created, [{ id: "file:s:src/new.ts", path: "src/new.ts" }]);
    const fileNode = plan.nodes.find((n: any) => n.id === "file:s:src/new.ts");
    assert.deepEqual(fileNode, {
      op: "create",
      id: "file:s:src/new.ts",
      type: "File",
      path: "src/new.ts",
      title: "new.ts",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("ensureEvidenceFileNodes: ディスクに無い path は typo として明示エラー (回復手段付き)", () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "evroot-"));
  try {
    const plan: any = {
      nodes: [{ op: "create", id: "decision:s:d", type: "Decision", title: "D", summary: "d" }],
      edges: [{ op: "create", id: "e1", type: "documented_by", from: "decision:s:d", to: "file:s:src/typo.ts" }],
    };
    assert.throws(
      () => ensureEvidenceFileNodes(plan, "/unused", { loadGraph: () => ({ nodes: [] }), repoRoot }),
      (e: any) => {
        assert.match(String(e.message), /does not exist on disk/, "『ディスクに無い』とはっきり言う");
        assert.match(String(e.message), /src\/typo\.ts/);
        assert.match(String(e.message), /commit-mutation/, "repo 外参照の手動作成手段を示す");
        return true;
      }
    );
    assert.equal(plan.nodes.length, 1, "エラー時は plan を汚さない");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("ensureEvidenceFileNodes: enforced_by 経路も自動作成し、エラーは --enforced-by 名義で言う", () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "evroot-"));
  try {
    mkdirSync(path.join(repoRoot, "test"), { recursive: true });
    writeFileSync(path.join(repoRoot, "test", "guard.test.ts"), "test('g', () => {});\n");
    const plan: any = {
      nodes: [{ op: "create", id: "constraint:s:c", type: "Constraint", title: "C", summary: "c" }],
      edges: [{ op: "create", id: "e1", type: "enforced_by", from: "constraint:s:c", to: "file:s:test/guard.test.ts" }],
    };
    const created = ensureEvidenceFileNodes(plan, "/unused", { loadGraph: () => ({ nodes: [] }), repoRoot });
    assert.deepEqual(created, [{ id: "file:s:test/guard.test.ts", path: "test/guard.test.ts" }]);

    const typoPlan: any = {
      nodes: [{ op: "create", id: "constraint:s:c", type: "Constraint", title: "C", summary: "c" }],
      edges: [{ op: "create", id: "e1", type: "enforced_by", from: "constraint:s:c", to: "file:s:test/typo.test.ts" }],
    };
    assert.throws(
      () => ensureEvidenceFileNodes(typoPlan, "/unused", { loadGraph: () => ({ nodes: [] }), repoRoot }),
      /--enforced-by file:s:test\/typo\.test\.ts.*does not exist on disk/
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("ensureEvidenceFileNodes: vault 既存 / plan 内作成済みの File には何もしない", () => {
  const plan: any = {
    nodes: [
      { op: "create", id: "decision:s:d", type: "Decision", title: "D", summary: "d" },
      { op: "create", id: "file:s:src/in-plan.ts", type: "File", path: "src/in-plan.ts", title: "in-plan.ts" },
    ],
    edges: [
      { op: "create", id: "e1", type: "documented_by", from: "decision:s:d", to: "file:s:src/in-plan.ts" },
      { op: "create", id: "e2", type: "documented_by", from: "decision:s:d", to: "file:s:src/in-vault.ts" },
    ],
  };
  const created = ensureEvidenceFileNodes(plan, "/unused", {
    loadGraph: () => ({ nodes: [{ id: "file:s:src/in-vault.ts", type: "File", path: "src/in-vault.ts" }] }),
    repoRoot: "/nonexistent-root", // 参照されないこと (どちらも既知なので disk を見ない)
  });
  assert.deepEqual(created, []);
  assert.equal(plan.nodes.length, 2);
});

test("add-decision: --evidence の File が vault に無くてもディスク実在なら自動作成して通る", async () => {
  const { repo, vault, stateDir } = gitInitVault();
  try {
    // repo 直下 (= vault を保持する .graphrag の親) に実在するソースを用意
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "fresh.ts"), "export const f = 1;\n");
    await withVaultEnv(vault, stateDir, () =>
      dispatchHeadline("add-decision", [
        "--system", "s",
        "--slug", "auto-ev",
        "--title", "Auto evidence",
        "--summary", "file node should be auto-created",
        "--evidence", "file:s:src/fresh.ts"
      ])
    );
    const imp = importVault(vault);
    const fileNode = imp.nodes.find((n) => n.id === "file:s:src/fresh.ts");
    assert.ok(fileNode, "File ノードが自動作成されている");
    assert.equal(fileNode.path, "src/fresh.ts");
    assert.ok(imp.nodes.some((n) => n.id === "decision:s:auto-ev"), "decision も書かれる");
    assert.ok(
      imp.edges.some((e) => e.type === "documented_by" && e.to === "file:s:src/fresh.ts"),
      "documented_by が繋がる"
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("add-decision: --evidence の path がディスクに無ければ『そう』と言って失敗する", async () => {
  const { repo, vault, stateDir } = gitInitVault();
  try {
    const head0 = vaultHead(vault);
    await withVaultEnv(vault, stateDir, () =>
      assert.rejects(
        () =>
          dispatchHeadline("add-decision", [
            "--system", "s",
            "--slug", "bad-ev",
            "--title", "Bad evidence",
            "--summary", "path typo must fail loudly",
            "--evidence", "file:s:src/does-not-exist.ts"
          ]),
        /does not exist on disk/
      )
    );
    assert.equal(vaultHead(vault), head0, "何も commit されない");
    assert.ok(!importVault(vault).nodes.some((n) => n.id === "decision:s:bad-ev"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
