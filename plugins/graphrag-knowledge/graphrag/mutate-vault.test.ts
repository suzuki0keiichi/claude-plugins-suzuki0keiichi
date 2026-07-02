import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildVaultFiles } from "./build-vault.ts";
import { writeVaultDelta, applyMutationToVault, vaultHead } from "./mutate-vault.ts";
import { importVault } from "./import-vault.ts";
import { defaultVectorIndexPath } from "./retrieval.ts";
import { readSeq } from "./vault-lock.ts";
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";

// Fixed timestamp so buildVaultFiles output is byte-identical across calls.
const FIXED_TS = "2026-01-01T00:00:00.000Z";

function seedVault(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vault-"));
  const g = {
    generated_at: FIXED_TS,
    nodes: [
      { id: "decision:s:a", type: "Decision", title: "A", summary: "a" },
    ],
    edges: [],
  };
  for (const f of buildVaultFiles(g)) {
    const abs = path.join(dir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  return dir;
}

test("追加ノードのファイルが書かれ既存数が増える", () => {
  const dir = seedVault();
  const before = importVault(dir).nodes.length;
  const next = {
    generated_at: FIXED_TS,
    nodes: [
      { id: "decision:s:a", type: "Decision", title: "A", summary: "a" },
      { id: "decision:s:c", type: "Decision", title: "C", summary: "c" },
    ],
    edges: [],
  };
  writeVaultDelta(dir, next);
  const after = importVault(dir);
  assert.equal(after.nodes.length, before + 1);
  assert.ok(after.nodes.some((n) => n.id === "decision:s:c"));
});

test("削除ノードのファイルは孤児として消える", () => {
  const dir = seedVault();
  const next = {
    generated_at: FIXED_TS,
    nodes: [],
    edges: [],
  };
  writeVaultDelta(dir, next);
  const after = importVault(dir);
  assert.ok(!after.nodes.some((n) => n.id === "decision:s:a"));
});

test("型フォルダが空になったら掃除される (旧型フォルダの空残骸防止)", () => {
  // ichibaya 実例: 全 Pocket ノードが Component に改名されると Pocket/*.md は消えるが、
  // 空の Pocket/ ディレクトリが残骸として残っていた。delta 書き込みで掃除する。
  const dir = seedVault(); // Decision (=> Decision/ フォルダ)
  assert.ok(existsSync(path.join(dir, "Decision")), "前提: Decision フォルダが存在");
  const next = {
    generated_at: FIXED_TS,
    nodes: [],
    edges: [],
  };
  writeVaultDelta(dir, next);
  assert.ok(!existsSync(path.join(dir, "Decision")), "空になった Decision フォルダは掃除される");
});

test("内容不変なら何も書かない (written 空)", () => {
  const dir = seedVault();
  const same = {
    generated_at: FIXED_TS,
    nodes: [
      { id: "decision:s:a", type: "Decision", title: "A", summary: "a" },
    ],
    edges: [],
  };
  const res = writeVaultDelta(dir, same);
  assert.deepEqual(res.written, []);
});

function gitInitVault(): { repo: string; vault: string; stateDir: string } {
  const repo = mkdtempSync(path.join(tmpdir(), "vrepo-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  const vault = path.join(repo, "vault");
  // seed は最低 1 ノード必要 (空だと git commit が nothing-to-commit で落ちる)
  for (const f of buildVaultFiles({
    generated_at: FIXED_TS,
    nodes: [{ id: "file:s:README.md", type: "File", title: "README.md", path: "README.md" }],
    edges: [],
  })) {
    const abs = path.join(vault, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed"]);
  const stateDir = path.join(path.dirname(vault), ".graphrag");
  mkdirSync(stateDir, { recursive: true });
  return { repo, vault, stateDir };
}

const noopIndex = async () => ({ stubbed: true });

// 妥当な plan: distilled な Decision は source-backing が必須 (enforceSourceBacking)。
// File ソース(path 付き) を一緒に作り documented_by で繋いだ "valid graph" を返す。
function decisionPlan(slug: string, reason: string) {
  const decisionId = `decision:s:${slug}`;
  const fileId = `file:s:src/${slug}.ts`;
  return {
    reason,
    nodes: [
      { op: "create", id: decisionId, type: "Decision", title: slug.toUpperCase(), summary: slug },
      { op: "create", id: fileId, type: "File", title: `${slug}.ts`, path: `src/${slug}.ts` },
    ],
    edges: [
      {
        op: "create",
        id: `decision_s_${slug}__documented_by__file_s_src_${slug}.ts`,
        type: "documented_by",
        from: decisionId,
        to: fileId,
      },
    ],
  };
}

test("applyMutationToVault: 妥当 plan を適用し git commit して HEAD が進む", async () => {
  const { vault, stateDir } = gitInitVault();
  const head0 = vaultHead(vault);
  const plan = decisionPlan("a", "add decision a");
  const res = await applyMutationToVault({ plan, vaultDir: vault, stateDir, git: true, buildIndex: noopIndex });
  assert.equal(res.applied, true);
  assert.equal(res.index_status.ok, true);
  assert.notEqual(vaultHead(vault), head0, "HEAD should advance");
});

// 回帰: 既定 buildIndex (buildIndex を渡さない = 本番 commit-mutation と同じ経路) は
// 計算した索引を実際に out へ書き出さねばならない。以前は buildVectorIndex を直に呼んで
// 戻り値を捨てており、index_status:ok でも vector.json が更新されない事故になっていた。
// endpoint 非依存にするため provider だけ vectorDeps で DI する。
test("既定 buildIndex は索引を out に実書きする (古い索引を上書き更新)", async () => {
  const { vault, stateDir } = gitInitVault();
  const indexPath = defaultVectorIndexPath(vault); // E1: <root>/.graphrag/cache/vector.json
  mkdirSync(path.dirname(indexPath), { recursive: true });
  // 古い(stale)索引を先に置く: バグ時はこれが据え置きのまま残る。
  writeFileSync(
    indexPath,
    JSON.stringify({ version: 1, generated_at: "STALE", rows: [{ node_id: "old:stale" }] })
  );
  const fakeProvider = {
    id: "fake",
    capability: "semantic",
    semantic: true,
    dimensions: 3,
    metadata: { endpoint: "fake://", model: "fake" },
    embed: async () => [0.1, 0.2, 0.3],
  };
  const plan = decisionPlan("idx", "add decision idx");
  const res = await applyMutationToVault({
    plan,
    vaultDir: vault,
    stateDir,
    git: true,
    vectorDeps: { provider: fakeProvider }, // buildIndex は渡さない = 既定経路を踏む
  });
  assert.equal(res.index_status.ok, true);
  const written = JSON.parse(readFileSync(indexPath, "utf8"));
  assert.notEqual(written.generated_at, "STALE", "索引は再構築され据え置きにならないこと");
  const ids = new Set(written.rows.map((r: any) => r.node_id));
  assert.ok(ids.has("decision:s:idx"), "新規ノードが on-disk 索引に載ること");
  assert.ok(!ids.has("old:stale"), "古い行は消えて全再構築されていること");
});

test("索引再構築はロック解放後に走る (ネットワーク IO をクリティカルセクションから外す)", async () => {
  const { vault, stateDir } = gitInitVault();
  let lockHeldDuringIndex: boolean | null = null;
  let seqParityDuringIndex: number | null = null;
  // buildIndex 実行時点のロック/seq 状態を観測する。ロック内で走るなら lock ファイルが
  // 存在し seq は奇数 (書込中)。ロック外なら lock 無し・seq 偶数 (窓は閉じている)。
  // E1: lock / seq は stateDir 直下ではなく cache/ に置かれる。
  const cacheDir = path.join(stateDir, "cache");
  const observingIndex = async () => {
    lockHeldDuringIndex = existsSync(path.join(cacheDir, "vault.lock"));
    seqParityDuringIndex = readSeq(cacheDir) % 2;
    return { ok: true };
  };
  const res = await applyMutationToVault({
    plan: decisionPlan("idx-outside", "x"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: observingIndex,
  });
  assert.equal(res.applied, true);
  assert.equal(res.index_status.ok, true, "index_status は従来どおり報告される");
  assert.equal(lockHeldDuringIndex, false, "索引ビルド時にロックは解放済みであること");
  assert.equal(seqParityDuringIndex, 0, "索引ビルド時に seq 書込窓(奇数)は閉じていること");
});

test("git commit は vault 外の staged 変更を巻き込まない (pathspec 限定 commit)", async () => {
  const { repo, vault, stateDir } = gitInitVault();
  // 利用者が repo の別所で作業中の変更を stage していた状況を再現する。
  writeFileSync(path.join(repo, "foreign.txt"), "user's unrelated work\n");
  execFileSync("git", ["-C", repo, "add", "foreign.txt"]);

  const res = await applyMutationToVault({
    plan: decisionPlan("ps", "pathspec commit"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
  });
  assert.equal(res.applied, true);

  const committed = execFileSync("git", ["-C", repo, "show", "--name-only", "--format=", "HEAD"], {
    encoding: "utf8",
  });
  assert.ok(!committed.includes("foreign.txt"), "他人の staged 変更は commit に入らない");
  assert.ok(committed.includes("Decision/"), "vault 配下の変更は commit される");
  const stillStaged = execFileSync("git", ["-C", repo, "diff", "--cached", "--name-only"], {
    encoding: "utf8",
  });
  assert.match(stillStaged, /foreign\.txt/, "利用者の staged 変更は index に残ったまま");
});

test("unborn branch (初回コミット前) でも pathspec 付き commit が通る", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "vrepo-unborn-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  const vault = path.join(repo, "vault");
  for (const f of buildVaultFiles({
    generated_at: FIXED_TS,
    nodes: [{ id: "file:s:README.md", type: "File", title: "README.md", path: "README.md" }],
    edges: [],
  })) {
    const abs = path.join(vault, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  // まだ 1 コミットも無い (unborn branch)。vault 外の staged 変更も同居させる。
  writeFileSync(path.join(repo, "foreign.txt"), "pre-staged elsewhere\n");
  execFileSync("git", ["-C", repo, "add", "foreign.txt"]);
  const stateDir = path.join(repo, ".graphrag");
  mkdirSync(stateDir, { recursive: true });

  const res = await applyMutationToVault({
    plan: decisionPlan("first", "initial commit on unborn branch"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
  });
  assert.equal(res.applied, true);
  assert.ok(res.head, "初回 commit で HEAD が生まれる");
  const committed = execFileSync("git", ["-C", repo, "show", "--name-only", "--format=", "HEAD"], {
    encoding: "utf8",
  });
  assert.ok(!committed.includes("foreign.txt"), "unborn でも vault 外 staged は巻き込まない");
  const stillStaged = execFileSync("git", ["-C", repo, "diff", "--cached", "--name-only"], {
    encoding: "utf8",
  });
  assert.match(stillStaged, /foreign\.txt/);
});

test("OCC: base_sha が現 HEAD と違えば拒否（適用しない）", async () => {
  const { vault, stateDir } = gitInitVault();
  const plan = decisionPlan("b", "x");
  await assert.rejects(
    () => applyMutationToVault({ plan, vaultDir: vault, stateDir, baseSha: "deadbeef", git: true, buildIndex: noopIndex }),
    /stale|OCC|base/i
  );
});

test("索引失敗は非致命: file 書き込み・commit は進み index_status.ok=false", async () => {
  const { vault, stateDir } = gitInitVault();
  const head0 = vaultHead(vault);
  const throwingIndex = async () => {
    throw new Error("no embedding endpoint");
  };
  const plan = decisionPlan("c", "add decision c");
  const res = await applyMutationToVault({ plan, vaultDir: vault, stateDir, git: true, buildIndex: throwingIndex });
  assert.equal(res.applied, true);
  assert.equal(res.index_status.ok, false);
  assert.notEqual(vaultHead(vault), head0, "mutation must still commit even if index fails");
});

test("commit 失敗時は all-or-nothing: working tree を HEAD へ巻き戻し reject", async () => {
  const { repo, vault, stateDir } = gitInitVault();
  const head0 = vaultHead(vault);
  // pre-commit hook を必ず失敗させて git commit を確実にエラーにする。
  const hook = path.join(repo, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);

  const plan = decisionPlan("d", "add decision d");
  await assert.rejects(
    () => applyMutationToVault({ plan, vaultDir: vault, stateDir, git: true, buildIndex: noopIndex })
  );

  // (a) vault 配下の working tree がクリーン（rollback で HEAD に戻った）。
  // pathspec を vault(.) に限定する。repo 直下の .graphrag(lock 等)は mutation の
  // 書き込み対象外なので除外する。
  const porcelain = execFileSync("git", ["status", "--porcelain", "--", "."], {
    cwd: vault,
    encoding: "utf8",
  }).trim();
  assert.equal(porcelain, "", "vault working tree must be clean after rollback");
  // (b) import に新ノードが残っていない（mutation 完全に取り消し）
  const after = importVault(vault);
  assert.ok(!after.nodes.some((n) => n.id === "decision:s:d"), "new node must be undone");
  // (c) HEAD 不変
  assert.equal(vaultHead(vault), head0, "HEAD must not advance on commit failure");
});

test("孤児削除はドットディレクトリ配下(.obsidian)の .md を消さない", () => {
  const dir = seedVault();
  const obsidianMd = path.join(dir, ".obsidian", "notes.md");
  mkdirSync(path.dirname(obsidianMd), { recursive: true });
  writeFileSync(obsidianMd, "# obsidian template\n");
  const same = {
    generated_at: FIXED_TS,
    nodes: [
      { id: "decision:s:a", type: "Decision", title: "A", summary: "a" },
    ],
    edges: [],
  };
  const res = writeVaultDelta(dir, same);
  assert.ok(existsSync(obsidianMd), ".obsidian/notes.md must not be deleted");
  assert.ok(
    !res.removed.includes(path.join(".obsidian", "notes.md")),
    ".obsidian/notes.md must not be in removed list"
  );
});

test("適用が途中(writeVaultDelta 内)で失敗しても HEAD へ巻き戻り部分適用が残らない", async () => {
  const { vault, stateDir } = gitInitVault();
  const head0 = vaultHead(vault);
  // 一部ファイルを書いて created に積んでから throw する writer を注入する
  // (rename 途中失敗・クラッシュ相当)。巻き戻しがこの partial を消すことを検証。
  const failingWriteDelta = (
    vaultDir: string,
    _next: any,
    sink: { written: string[]; removed: string[]; created: string[] }
  ) => {
    const rel = path.join("Decision", "STRAY.md");
    const abs = path.join(vaultDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "stray partial content\n");
    sink.created.push(rel);
    throw new Error("injected mid-apply write failure");
  };
  await assert.rejects(() =>
    applyMutationToVault({
      plan: decisionPlan("e", "add decision e"),
      vaultDir: vault,
      stateDir,
      git: true,
      buildIndex: noopIndex,
      writeDelta: failingWriteDelta,
    })
  );
  // (a) 座礁ファイルが消えている  (b) working tree クリーン  (c) HEAD 不変
  assert.ok(!existsSync(path.join(vault, "Decision", "STRAY.md")), "partial file must be removed");
  const porcelain = execFileSync("git", ["status", "--porcelain", "--", "."], {
    cwd: vault,
    encoding: "utf8",
  }).trim();
  assert.equal(porcelain, "", "vault working tree must be clean after rollback");
  assert.equal(vaultHead(vault), head0, "HEAD must not advance on mid-apply failure");
});

// ── A1 書き込み時重複ゲート ─────────────────────────────────────────
// 既存 Decision を seed した vault と、その embedding 行を持つ偽索引で照合経路を踏む。

function gitInitVaultWithDecision(): { repo: string; vault: string; stateDir: string } {
  const { repo, vault, stateDir } = gitInitVault();
  const g = {
    generated_at: FIXED_TS,
    nodes: [
      { id: "file:s:README.md", type: "File", title: "README.md", path: "README.md" },
      { id: "decision:s:a", type: "Decision", title: "A", summary: "a" },
    ],
    edges: [
      {
        id: "decision_s_a__documented_by__file_s_README.md",
        type: "documented_by",
        from: "decision:s:a",
        to: "file:s:README.md",
      },
    ],
  };
  for (const f of buildVaultFiles(g)) {
    const abs = path.join(vault, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed decision"]);
  return { repo, vault, stateDir };
}

const dupIndexFor = (vector: number[]) => ({
  rows: [{ node_id: "decision:s:a", dimensions: vector.length, vector }],
});

test("重複ゲート: 未承認 suspect は all-or-nothing で reject (HEAD 不変・無書き込み)", async () => {
  const { vault, stateDir } = gitInitVaultWithDecision();
  const head0 = vaultHead(vault);
  await assert.rejects(
    () =>
      applyMutationToVault({
        plan: decisionPlan("a2", "near-duplicate of a"),
        vaultDir: vault,
        stateDir,
        git: true,
        buildIndex: noopIndex,
        dupDeps: {
          loadIndex: () => dupIndexFor([1, 0, 0]),
          embed: async () => [1, 0, 0],
        },
      }),
    (err: any) => {
      assert.equal(err.code, "DUPLICATE_SUSPECT");
      assert.deepEqual(err.failures, [
        "duplicate-suspect: decision:s:a2 ~ decision:s:a (similarity 1.00)",
      ]);
      assert.equal(err.duplicate_check.suspects[0].existing_id, "decision:s:a");
      return true;
    }
  );
  assert.equal(vaultHead(vault), head0, "HEAD must not advance on duplicate reject");
  const after = importVault(vault);
  assert.ok(!after.nodes.some((n) => n.id === "decision:s:a2"), "node must not be written");
});

test("重複ゲート: duplicate_ack が suspect を覆えば acked で適用される", async () => {
  const { vault, stateDir } = gitInitVaultWithDecision();
  const head0 = vaultHead(vault);
  const res = await applyMutationToVault({
    plan: { ...decisionPlan("a2", "ack duplicate of a"), duplicate_ack: ["decision:s:a"] },
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
    dupDeps: {
      loadIndex: () => dupIndexFor([1, 0, 0]),
      embed: async () => [1, 0, 0],
    },
  });
  assert.equal(res.applied, true);
  assert.equal(res.duplicate_check.status, "acked");
  assert.equal(res.duplicate_check.suspects.length, 1, "ack しても suspect は可視のまま");
  assert.notEqual(vaultHead(vault), head0, "HEAD should advance");
});

test("重複ゲート: suspect 無しなら status ok で出力に載る", async () => {
  const { vault, stateDir } = gitInitVaultWithDecision();
  const res = await applyMutationToVault({
    plan: decisionPlan("zz", "unrelated decision"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
    dupDeps: {
      loadIndex: () => dupIndexFor([1, 0, 0]),
      embed: async () => [0, 1, 0], // 直交 = cosine 0
    },
  });
  assert.equal(res.applied, true);
  assert.equal(res.duplicate_check.status, "ok");
  assert.deepEqual(res.duplicate_check.suspects, []);
  assert.deepEqual(res.duplicate_check.cross_type_suspects, []);
  // ask-trail が空 (この state dir で ask 未実行) + 知識ノード作成 → advisory precheck が載る。
  assert.equal(res.duplicate_check.precheck.recent_ask_hits, 0);
  assert.match(res.duplicate_check.precheck.note, /ask/);
});

test("重複ゲート: vector index 不在は非致命 skip で mutation は通る (index_status と同じ扱い)", async () => {
  const { vault, stateDir } = gitInitVaultWithDecision();
  // dupDeps 無し = 既定経路: defaultVectorIndexPath に索引が無く loadVectorIndex が null。
  // embed には到達しない (= ネットワーク非依存でこのテストが成立する)。
  const res = await applyMutationToVault({
    plan: decisionPlan("a2", "no index present"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
  });
  assert.equal(res.applied, true);
  assert.equal(res.duplicate_check.status, "skipped");
  assert.ok(res.duplicate_check.reason, "skip 理由を可視化");
});

test("重複ゲート: embedding 不達は非致命 skip で mutation は通る", async () => {
  const { vault, stateDir } = gitInitVaultWithDecision();
  const res = await applyMutationToVault({
    plan: decisionPlan("a2", "endpoint down"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
    dupDeps: {
      loadIndex: () => dupIndexFor([1, 0, 0]),
      embed: async () => {
        throw new Error("embedding endpoint unreachable");
      },
    },
  });
  assert.equal(res.applied, true);
  assert.equal(res.duplicate_check.status, "skipped");
  assert.match(res.duplicate_check.reason, /unreachable/);
});

// ── E0 書き込み時提案 (suggestions) ──────────────────────────────────────
// 正常系 (binding が出る) / index 無しで skip / 提案がエッジを勝手に作らない の3点を固定。

// File 行を持つ偽索引。binding は impl File (docs/knowhow/plans/design-decisions 以外) を
// 候補にするので src/ 配下の File 行を用意する。
const suggestIndexWithFile = (fileId: string, vector: number[]) => ({
  rows: [{ node_id: fileId, dimensions: vector.length, vector, path: "src/x.ts" }],
});

test("suggestions: 新規 Decision に対し binding 候補が出る (正常系)", async () => {
  const { vault, stateDir } = gitInitVaultWithDecision();
  const res = await applyMutationToVault({
    plan: decisionPlan("bind1", "decision needing a binding"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
    // duplicate gate は別 index/embed で素通りさせ、suggestions だけ DI で観測する。
    dupDeps: { loadIndex: () => ({ rows: [] }) }, // index 不在扱い = dup skip
    suggestDeps: {
      loadIndex: () => suggestIndexWithFile("file:s:src/x.ts", [1, 0, 0]),
      embed: async () => [1, 0, 0], // File と同方向 = cosine 1.0
      recentHitIds: () => [],
    },
  });
  assert.equal(res.applied, true);
  assert.ok(res.suggestions, "suggestions が出力に同梱される");
  const bindings = res.suggestions.binding.suggestions;
  const forDecision = bindings.find((b: any) => b.node_id === "decision:s:bind1");
  assert.ok(forDecision, "新規 Decision に対する binding 提案が在る");
  assert.equal(forDecision.edge_type, "sets_policy_for", "Decision の提案エッジ型は固定");
  assert.equal(forDecision.candidates[0].file_id, "file:s:src/x.ts");
  assert.ok(forDecision.candidates[0].similarity >= 0.7);
  assert.equal(res.suggestions.binding_debt >= 0, true, "binding_debt は整数で同梱");
});

test("suggestions: vector index 無しは binding を skip + reason (mutation は通る)", async () => {
  const { vault, stateDir } = gitInitVaultWithDecision();
  const res = await applyMutationToVault({
    plan: decisionPlan("bind2", "no index for suggestions"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
    dupDeps: { loadIndex: () => ({ rows: [] }) },
    suggestDeps: {
      loadIndex: () => null, // index 不在
      recentHitIds: () => [],
    },
  });
  assert.equal(res.applied, true);
  assert.deepEqual(res.suggestions.binding.suggestions, []);
  assert.ok(res.suggestions.binding.skipped, "skip 理由が可視化される");
});

test("suggestions: 提案はエッジを一切作らない (vault のエッジ数が増えない)", async () => {
  const { vault, stateDir } = gitInitVaultWithDecision();
  const edgesBefore = importVault(vault).edges.length;
  const res = await applyMutationToVault({
    plan: decisionPlan("bind3", "suggestions must not write edges"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
    dupDeps: { loadIndex: () => ({ rows: [] }) },
    suggestDeps: {
      loadIndex: () => suggestIndexWithFile("file:s:src/x.ts", [1, 0, 0]),
      embed: async () => [1, 0, 0],
      recentHitIds: () => [],
    },
  });
  assert.equal(res.applied, true);
  // binding 提案が在る (= 提案器は走った) ことを前提に、それでもエッジは張られていない。
  assert.ok(res.suggestions.binding.suggestions.length > 0, "提案器は走っている");
  const after = importVault(vault);
  // plan が documented_by を 1 本足すので before+1。提案由来の余分なエッジは無い。
  assert.equal(after.edges.length, edgesBefore + 1, "提案は plan 外のエッジを作らない");
  assert.ok(
    !after.edges.some((e: any) => e.type === "sets_policy_for"),
    "binding 提案の sets_policy_for は vault に書かれていない"
  );
});

test("detached HEAD の vault では mutation を拒否する(浮きコミット防止)", async () => {
  const { repo, vault, stateDir } = gitInitVault();
  const head0 = vaultHead(vault);
  // submodule update 相当: HEAD を detached にする。
  execFileSync("git", ["-C", repo, "checkout", "-q", "--detach", "HEAD"]);
  await assert.rejects(
    () =>
      applyMutationToVault({
        plan: decisionPlan("f", "add decision f"),
        vaultDir: vault,
        stateDir,
        git: true,
        buildIndex: noopIndex,
      }),
    (err: any) => err?.code === "DETACHED_HEAD"
  );
  // 適用前に弾くので何も書かれず HEAD も動かない。
  const porcelain = execFileSync("git", ["status", "--porcelain", "--", "."], {
    cwd: vault,
    encoding: "utf8",
  }).trim();
  assert.equal(porcelain, "", "nothing must be written when detached");
  assert.equal(vaultHead(vault), head0, "HEAD must not change");
});

// ── 重複ゲートの埋め込み空間 / 索引 staleness / ロック外 embedding ─────────────

import http from "node:http";

/** OpenAI 互換 embedding endpoint のモック。受け取った input を記録して固定ベクトルを返す。 */
function startCapturingEmbeddingMock(vector: number[]): Promise<{
  base: string;
  inputs: string[];
  close: () => Promise<void>;
}> {
  const inputs: string[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && (req.url ?? "").includes("/models")) {
        res.end(JSON.stringify({ data: [{ id: "nomic-embed-text" }] }));
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          inputs.push(JSON.parse(body).input);
        } catch {
          /* noop */
        }
        res.end(JSON.stringify({ data: [{ embedding: vector }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        base: `http://127.0.0.1:${addr.port}/v1`,
        inputs,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test("重複ゲート: 既定 embed は索引の document 側接頭辞で埋め込む (query 側ではない)", async () => {
  // 索引行は document 接頭辞で埋め込まれている (build-vector-index)。ゲートの既定 embed が
  // query 側で埋め込むと空間がずれ 0.92 閾値が系統的に甘くなる回帰の固定。
  const mock = await startCapturingEmbeddingMock([1, 0]);
  const { vault, stateDir } = gitInitVaultWithDecision();
  const index = {
    version: 1,
    provider: "openai-compatible-embedding",
    provider_capability: "semantic",
    semantic: true,
    dimensions: 2,
    provider_options: { endpoint: `${mock.base}/embeddings`, model: "nomic-embed-text" },
    prefix_policy: { document: "search_document: ", query: "search_query: " },
    rows: [{ node_id: "decision:s:a", dimensions: 2, vector: [0, 1] }], // 直交 → suspect 無し
  };
  try {
    const res = await applyMutationToVault({
      plan: decisionPlan("doc1", "default embed must be document-side"),
      vaultDir: vault,
      stateDir,
      git: true,
      buildIndex: noopIndex,
      dupDeps: { loadIndex: () => index }, // embed は渡さない = 既定経路 (embedForIndex document)
    });
    assert.equal(res.applied, true);
    assert.ok(mock.inputs.length > 0, "ゲート候補が埋め込まれている");
    assert.ok(
      mock.inputs.every((i) => i.startsWith("search_document: ")),
      `既定 embed は document 接頭辞で埋め込む (got: ${JSON.stringify(mock.inputs)})`
    );
    assert.ok(!mock.inputs.some((i) => i.startsWith("search_query: ")), "query 接頭辞は使わない");
  } finally {
    await mock.close();
  }
});

test("重複ゲート: 索引の vault_head が現 HEAD と違えば duplicate_check.index_stale (非致命)", async () => {
  const { vault, stateDir } = gitInitVaultWithDecision();
  const res = await applyMutationToVault({
    plan: decisionPlan("st1", "stale index visibility"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
    dupDeps: {
      loadIndex: () => ({ ...dupIndexFor([1, 0, 0]), vault_head: "deadbeef" }),
      embed: async () => [0, 1, 0], // 直交 = suspect 無し
    },
  });
  assert.equal(res.applied, true, "index_stale は情報提供のみで mutation を止めない");
  assert.equal(res.duplicate_check.status, "ok");
  assert.equal(res.duplicate_check.index_stale, true);
  assert.match(res.duplicate_check.index_stale_reason, /deadbeef/);
});

test("重複ゲート: vault_head が現 HEAD と一致 (または打刻無し) なら index_stale は載らない", async () => {
  const { vault, stateDir } = gitInitVaultWithDecision();
  const head0 = vaultHead(vault);
  const res = await applyMutationToVault({
    plan: decisionPlan("st2", "fresh index"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
    dupDeps: {
      loadIndex: () => ({ ...dupIndexFor([1, 0, 0]), vault_head: head0 }),
      embed: async () => [0, 1, 0],
    },
  });
  assert.equal(res.duplicate_check.index_stale, undefined);
  assert.equal(res.duplicate_check.index_stale_reason, undefined);
});

test("重複ゲート: 候補の embedding はロック取得前に走る (ネットワーク IO をロック外へ)", async () => {
  const { vault, stateDir } = gitInitVaultWithDecision();
  const cacheDir = path.join(stateDir, "cache");
  let lockHeldDuringEmbed: boolean | null = null;
  const res = await applyMutationToVault({
    plan: decisionPlan("pre1", "gate embed outside lock"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
    dupDeps: {
      loadIndex: () => dupIndexFor([1, 0, 0]),
      embed: async () => {
        lockHeldDuringEmbed = existsSync(path.join(cacheDir, "vault.lock"));
        return [0, 1, 0];
      },
    },
  });
  assert.equal(res.applied, true);
  assert.equal(lockHeldDuringEmbed, false, "ゲートの embedding 時点で vault.lock は未取得であること");
});

// ── E0 提案: 候補メタ補完 / ask-precheck ────────────────────────────────────

test("suggestions: binding 候補に path/title が nextGraph から補完される (write path の索引行は素形)", async () => {
  const { vault, stateDir } = gitInitVaultWithDecision();
  const res = await applyMutationToVault({
    plan: decisionPlan("bind4", "candidate meta merge"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
    dupDeps: { loadIndex: () => ({ rows: [] }) },
    suggestDeps: {
      // write path の実索引行と同じ素形 {node_id, dimensions, vector, text_hash} (path/title 無し)
      loadIndex: () => ({
        rows: [{ node_id: "file:s:src/bind4.ts", dimensions: 3, vector: [1, 0, 0], text_hash: "x" }],
      }),
      embed: async () => [1, 0, 0],
      recentHitIds: () => [],
    },
  });
  const forDecision = res.suggestions.binding.suggestions.find(
    (b: any) => b.node_id === "decision:s:bind4"
  );
  assert.ok(forDecision, "binding 提案が在る");
  const cand = forDecision.candidates[0];
  assert.equal(cand.file_id, "file:s:src/bind4.ts");
  assert.equal(cand.path, "src/bind4.ts", "path は nextGraph の File ノードから補完");
  assert.equal(cand.title, "bind4.ts", "title は nextGraph の File ノードから補完");
  // 確定手段はそのまま貼れる plan_fragment (E0 apply レシピ)。
  assert.equal(cand.apply.plan_fragment.type, "sets_policy_for");
  assert.equal(cand.apply.plan_fragment.from, "decision:s:bind4");
  assert.equal(cand.apply.plan_fragment.to, "file:s:src/bind4.ts");
});

test("precheck: ask-trail に直近ヒットがあれば duplicate_check.precheck は載らない", async () => {
  const { vault, stateDir } = gitInitVaultWithDecision();
  const res = await applyMutationToVault({
    plan: decisionPlan("pc1", "precheck satisfied"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
    dupDeps: { loadIndex: () => ({ rows: [] }) },
    suggestDeps: {
      loadIndex: () => null,
      recentHitIds: () => ["decision:s:a"], // 直近 ask ヒットあり
    },
  });
  assert.equal(res.applied, true);
  assert.equal(res.duplicate_check.precheck, undefined, "ヒットがあれば advisory は不要");
});

test("precheck: 知識ノード作成 + ask-trail 空なら advisory precheck が載る (非ブロッキング)", async () => {
  const { vault, stateDir } = gitInitVaultWithDecision();
  const res = await applyMutationToVault({
    plan: decisionPlan("pc2", "precheck missing"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
    dupDeps: { loadIndex: () => ({ rows: [] }) },
    suggestDeps: {
      loadIndex: () => null,
      recentHitIds: () => [],
    },
  });
  assert.equal(res.applied, true, "precheck は決して reject しない");
  assert.deepEqual(res.duplicate_check.precheck, {
    recent_ask_hits: 0,
    note: res.duplicate_check.precheck.note,
  });
  assert.match(res.duplicate_check.precheck.note, /ask/);
});
