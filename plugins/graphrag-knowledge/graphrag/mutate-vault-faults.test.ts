// 書き込み経路のフォールト注入テスト。
//
// 主張 (all-or-nothing): 適用のどこで死んでも、ディスク上の vault は
// 「完全な旧状態」か「完全な新状態」のどちらかであり、決して裂けない (torn write なし)。
// かつ報告された結果 (applied / reject) は実際のディスク状態と一致する。
//
// 各注入後に必ず importVault + validateGraph をディスクの vault に対して回し、
// 「クリーンにパースできる」「期待した側 (旧 or 新) と deepEqual」まで固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildVaultFiles } from "./build-vault.ts";
import {
  applyMutationToVault,
  writeVaultDelta,
  writeFileAtomic,
  vaultHead,
} from "./mutate-vault.ts";
import { importVault } from "./import-vault.ts";
import { validateGraph } from "./schema.ts";
import { readSeq, beginVaultWrite } from "./vault-lock.ts";
import { defaultVectorIndexPath } from "./retrieval.ts";
import { fsckVault } from "./fsck.ts";

const FIXED_TS = "2026-01-01T00:00:00.000Z";
const noopIndex = async () => ({ stubbed: true });

function gitInitVault(): { repo: string; vault: string; stateDir: string; cacheDir: string } {
  const repo = mkdtempSync(path.join(tmpdir(), "vfault-"));
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
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed"]);
  const stateDir = path.join(repo, ".graphrag");
  mkdirSync(stateDir, { recursive: true });
  return { repo, vault, stateDir, cacheDir: path.join(stateDir, "cache") };
}

/** 既存 Decision + documented_by File を追加 seed して commit。 */
function seedDecision(repo: string, vault: string): void {
  for (const f of buildVaultFiles({
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
  })) {
    const abs = path.join(vault, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed decision"]);
}

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

function porcelain(vault: string): string {
  return execFileSync("git", ["status", "--porcelain", "--", "."], {
    cwd: vault,
    encoding: "utf8",
  }).trim();
}

/** vault 直下の全ファイルから *.tmp 残骸を探す (原子書きの座礁検知)。 */
function findTmpFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === ".git") continue;
      const abs = path.join(d, e);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (e.endsWith(".tmp")) out.push(abs);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/**
 * 注入後の共通アサーション: ディスクの vault が「期待した側」そのものである。
 *  - importVault がクリーンにパースできる
 *  - validateGraph が空 (schema 整合)
 *  - 期待グラフと deepEqual (裂けた中間状態でない)
 */
function assertVaultEquals(vault: string, expected: { nodes: any[]; edges: any[] }, label: string) {
  const after = importVault(vault);
  assert.deepEqual(validateGraph(after), [], `${label}: on-disk vault must validate clean`);
  assert.deepEqual(after, expected, `${label}: on-disk vault must equal the expected side exactly`);
}

function assertWriterQuiescent(vault: string, cacheDir: string, label: string) {
  assert.ok(!existsSync(path.join(cacheDir, "vault.lock")), `${label}: lock must be released`);
  assert.equal(readSeq(cacheDir) % 2, 0, `${label}: seq write-window must be closed (even)`);
  assert.equal(porcelain(vault), "", `${label}: vault working tree must be clean`);
}

/** 確実に死んでいる PID (直前に exit した子プロセス)。 */
function deadPid(): number {
  const child = spawnSync("sleep", ["0"]);
  return child.pid!;
}

// ── 注入 1: git commit 失敗 (mid-flight で repo を壊す) ─────────────────────

test("注入1: delta 書き込み後に git commit が失敗 → 完全な旧状態へ巻き戻り・エラー伝播・ロック解放", async () => {
  const { repo, vault, stateDir, cacheDir } = gitInitVault();
  const snap = importVault(vault);
  const head0 = vaultHead(vault);
  const hook = path.join(repo, ".git", "hooks", "pre-commit");

  // mid-flight 注入: 実 writeVaultDelta を通した「後」に repo を壊す (commit だけが失敗する)。
  const midFlightBreakGit = (
    dir: string,
    g: any,
    sink: { written: string[]; removed: string[]; created: string[] }
  ) => {
    const r = writeVaultDelta(dir, g, sink);
    assert.ok(r.written.length > 0, "前提: delta は実際に書かれた");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    return r;
  };

  await assert.rejects(
    () =>
      applyMutationToVault({
        plan: decisionPlan("g1", "commit will fail"),
        vaultDir: vault,
        stateDir,
        git: true,
        buildIndex: noopIndex,
        writeDelta: midFlightBreakGit,
      }),
    (err: any) => err instanceof Error, // エラーは握り潰されず伝播する
    "commit failure must propagate as a rejection"
  );

  assert.equal(vaultHead(vault), head0, "HEAD must not advance");
  assertWriterQuiescent(vault, cacheDir, "注入1");
  assertVaultEquals(vault, snap, "注入1 (old side)");
  assert.deepEqual(findTmpFiles(vault), [], "no stranded .tmp files");

  // 「報告された結果が現実と一致」の裏取り: 修復後の次 mutation は普通に成功する
  // (= ロックも seq も vault も再利用可能な状態で残っている)。
  unlinkSync(hook);
  const res = await applyMutationToVault({
    plan: decisionPlan("g2", "after repair"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
  });
  assert.equal(res.applied, true);
  assert.notEqual(vaultHead(vault), head0);
  assert.equal(porcelain(vault), "");
});

// ── 注入 2: writeVaultDelta 途中 (k 番目のファイル) で FS 障害 ────────────────

test("注入2: k番目のファイル書きで FS 障害 → 半端ファイルも .tmp も残らず完全な旧状態", async () => {
  const { vault, stateDir, cacheDir } = gitInitVault();
  const snap = importVault(vault);
  const head0 = vaultHead(vault);

  // 実 writeVaultDelta の deps seam で 2 ファイル目の書きを EACCES 相当で落とす
  // (1 ファイル目は本物の writeFileAtomic で実書き = 本当に partial が発生する)。
  let writes = 0;
  const failOnSecond = (abs: string, content: string) => {
    writes += 1;
    if (writes >= 2) {
      throw Object.assign(new Error("EACCES: injected disk failure on file #2"), { code: "EACCES" });
    }
    writeFileAtomic(abs, content);
  };

  await assert.rejects(
    () =>
      applyMutationToVault({
        plan: decisionPlan("fs1", "disk dies mid-delta"),
        vaultDir: vault,
        stateDir,
        git: true,
        buildIndex: noopIndex,
        writeDelta: (dir, g, sink) => writeVaultDelta(dir, g, sink, { writeFile: failOnSecond }),
      }),
    /EACCES|injected disk failure/
  );
  assert.equal(writes, 2, "前提: 1 ファイル書けてから 2 ファイル目で死んだ (partial 発生)");

  assert.equal(vaultHead(vault), head0, "HEAD must not advance");
  assertWriterQuiescent(vault, cacheDir, "注入2");
  assertVaultEquals(vault, snap, "注入2 (old side)"); // 半端に書かれたノードファイルが残っていない
  assert.deepEqual(findTmpFiles(vault), [], "no orphaned .tmp files");

  // 復旧後の書き込みは成功する (ロック解放の裏取り)。
  const res = await applyMutationToVault({
    plan: decisionPlan("fs2", "after disk recovered"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
  });
  assert.equal(res.applied, true);
});

test("注入2b: writeFileAtomic は rename 失敗時に .tmp を座礁させない (単体)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "atomic-"));
  // rename(file, 既存ディレクトリ) は必ず失敗する → cleanup 経路を決定論的に踏む。
  const target = path.join(dir, "occupied");
  mkdirSync(target);
  assert.throws(() => writeFileAtomic(target, "content"));
  assert.deepEqual(
    readdirSync(dir).filter((e) => e.includes(".tmp")),
    [],
    "tmp file must be cleaned up on rename failure"
  );
});

// ── 注入 3: 重複ゲート時に embedding endpoint が死んでいる (既存挙動の固定) ────

test("注入3: embedding 不達 → gate は skipped で書き込みは進む (新状態がディスクに確定)", async () => {
  const { repo, vault, stateDir, cacheDir } = gitInitVault();
  seedDecision(repo, vault);
  const head0 = vaultHead(vault);

  const res = await applyMutationToVault({
    plan: decisionPlan("emb1", "endpoint down"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
    dupDeps: {
      loadIndex: () => ({ rows: [{ node_id: "decision:s:a", dimensions: 3, vector: [1, 0, 0] }] }),
      embed: async () => {
        throw new Error("embedding endpoint unreachable");
      },
    },
  });
  assert.equal(res.applied, true);
  assert.equal(res.duplicate_check.status, "skipped");
  assert.match(res.duplicate_check.reason, /unreachable/);
  assert.notEqual(vaultHead(vault), head0, "commit は進む");
  assertWriterQuiescent(vault, cacheDir, "注入3");
  // 報告 (applied) と現実の一致: 新ノードがディスクに在り、クリーンに validate できる。
  const after = importVault(vault);
  assert.deepEqual(validateGraph(after), []);
  assert.ok(after.nodes.some((n: any) => n.id === "decision:s:emb1"));
});

test("注入3b: embedding 不達でも lexical pre-pass は走る (完全一致タイトルは reject・vault は旧状態のまま)", async () => {
  const { repo, vault, stateDir, cacheDir } = gitInitVault();
  seedDecision(repo, vault);
  const snap = importVault(vault);
  const head0 = vaultHead(vault);

  // 既存 decision:s:a と正規化 title が完全一致する新規ノード。embedding は落ちている。
  const plan = {
    reason: "lexical duplicate while endpoint is down",
    nodes: [
      { op: "create", id: "decision:s:a2", type: "Decision", title: " a ", summary: "same name" },
      { op: "create", id: "file:s:src/a2.ts", type: "File", title: "a2.ts", path: "src/a2.ts" },
    ],
    edges: [
      {
        op: "create",
        id: "decision_s_a2__documented_by__file_s_src_a2.ts",
        type: "documented_by",
        from: "decision:s:a2",
        to: "file:s:src/a2.ts",
      },
    ],
  };
  await assert.rejects(
    () =>
      applyMutationToVault({
        plan,
        vaultDir: vault,
        stateDir,
        git: true,
        buildIndex: noopIndex,
        dupDeps: {
          loadIndex: () => ({ rows: [{ node_id: "decision:s:a", dimensions: 3, vector: [1, 0, 0] }] }),
          embed: async () => {
            throw new Error("embedding endpoint unreachable");
          },
        },
      }),
    (err: any) => {
      assert.equal(err.code, "DUPLICATE_SUSPECT");
      assert.match(err.failures[0], /lexical exact match/);
      return true;
    }
  );
  assert.equal(vaultHead(vault), head0, "reject なので HEAD 不変");
  assertWriterQuiescent(vault, cacheDir, "注入3b");
  assertVaultEquals(vault, snap, "注入3b (old side)");
});

// ── 注入 4: post-commit の索引再構築が失敗 (既存挙動の固定) ───────────────────

test("注入4: 索引再構築失敗 → mutation は成功報告・commit 済み、次の書き込みで index_stale が立つ", async () => {
  const { repo, vault, stateDir, cacheDir } = gitInitVault();
  seedDecision(repo, vault);
  const head0 = vaultHead(vault);

  // on-disk 索引: 現 HEAD で打刻済み (= この時点では新鮮)。
  const indexPath = defaultVectorIndexPath(vault);
  mkdirSync(path.dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, JSON.stringify({ version: 1, vault_head: head0, rows: [] }));

  // mutation 1: 再構築が落ちる → 非致命 (成功報告・commit 済み)。索引ファイルは古いまま残る。
  const res1 = await applyMutationToVault({
    plan: decisionPlan("ix1", "index rebuild will fail"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: async () => {
      throw new Error("no embedding endpoint");
    },
  });
  assert.equal(res1.applied, true, "mutation は成功と報告される");
  assert.equal(res1.index_status.ok, false, "索引失敗は正直に報告される");
  const head1 = vaultHead(vault);
  assert.notEqual(head1, head0, "vault は commit 済み");
  assert.equal(porcelain(vault), "");
  const after1 = importVault(vault);
  assert.deepEqual(validateGraph(after1), []);
  assert.ok(after1.nodes.some((n: any) => n.id === "decision:s:ix1"), "新状態がディスクに確定");

  // mutation 2 (dupDeps 無し = 既定経路が on-disk 索引を読む): index_stale が立つ。
  const res2 = await applyMutationToVault({
    plan: decisionPlan("ix2", "next write sees stale index"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
  });
  assert.equal(res2.applied, true);
  assert.equal(res2.duplicate_check.index_stale, true, "古い索引でゲートが回ったことが可視化される");
  assert.match(res2.duplicate_check.index_stale_reason, new RegExp(head0));
  assertWriterQuiescent(vault, cacheDir, "注入4");
});

// ── 注入 5: delta 書き込みと git commit の間でプロセス kill ──────────────────

test("注入5: delta と commit の間で kill → fsck が torn write を検知し、次の mutation が自己回復する", async () => {
  const { vault, stateDir, cacheDir } = gitInitVault();
  mkdirSync(cacheDir, { recursive: true });
  const head0 = vaultHead(vault);

  // 段階を手で刻んで kill を再現する:
  //   lock 取得 → seq 奇数 → writeVaultDelta 完了 → ここでプロセス死亡 (commit 前)。
  const began = beginVaultWrite(cacheDir); // seq 奇数 = 書込窓が開いたまま
  assert.equal(began % 2, 1);
  writeFileSync(
    path.join(cacheDir, "vault.lock"),
    JSON.stringify({ pid: deadPid(), ts: Date.now() }) // 死んだ writer のロック残骸
  );
  const torn = {
    generated_at: FIXED_TS,
    nodes: [
      { id: "file:s:README.md", type: "File", title: "README.md", path: "README.md" },
      { id: "decision:s:torn", type: "Decision", title: "Torn", summary: "written but never committed" },
    ],
    edges: [],
  };
  const delta = writeVaultDelta(vault, torn);
  assert.ok(delta.written.length > 0, "前提: 未 commit の delta がディスクに在る");
  assert.equal(vaultHead(vault), head0, "前提: commit はされていない (torn)");

  // (a) fsck は torn write を ERROR + 復旧ヒントで検知する。
  const report = fsckVault({ vaultDir: vault });
  assert.equal(report.status, "error");
  const gitCheck = report.checks.find((c) => c.id === "git-uncommitted")!;
  assert.equal(gitCheck.status, "error");
  assert.match(gitCheck.hint ?? "", /torn write/);
  assert.match(gitCheck.hint ?? "", /restore --source=HEAD/);
  // torn でも「裂けて」はいない (delta 書き自体は完結した): parse + validate はクリーン。
  const tornDisk = importVault(vault);
  assert.deepEqual(validateGraph(tornDisk), []);
  assert.ok(tornDisk.nodes.some((n: any) => n.id === "decision:s:torn"));

  // (b) 次の mutation は自己回復する: 死んだ writer のロックを奪い、seq 窓を閉じ、
  //     未 commit delta を自分の commit に吸収して整合状態へ戻す。
  const res = await applyMutationToVault({
    plan: decisionPlan("rec1", "recovery mutation"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
  });
  assert.equal(res.applied, true, "stale lock (dead pid) は奪取され mutation は通る");
  assert.notEqual(vaultHead(vault), head0);
  assertWriterQuiescent(vault, cacheDir, "注入5 回復後");
  const after = importVault(vault);
  assert.deepEqual(validateGraph(after), []);
  assert.ok(after.nodes.some((n: any) => n.id === "decision:s:torn"), "torn delta は commit に吸収");
  assert.ok(after.nodes.some((n: any) => n.id === "decision:s:rec1"), "新 mutation も適用");

  // (c) 回復後の fsck は全チェック ok。
  const report2 = fsckVault({ vaultDir: vault });
  assert.equal(report2.status, "ok");
});

// ── 書き込み後セルフチェック (unexplained-removal) ───────────────────────────

test("self-check: 説明できないファイル削除 (plan に無いノード消滅) は commit 前に throw して巻き戻る", async () => {
  const { repo, vault, stateDir, cacheDir } = gitInitVault();
  seedDecision(repo, vault);
  const snap = importVault(vault);
  const head0 = vaultHead(vault);

  // ライタ層のバグを模擬: writeVaultDelta に渡る直前に nextGraph からノードを黙って落とす
  // (= 生成集合から消え、実 writeVaultDelta が孤児としてファイルを削除する)。
  const buggyWriter = (
    dir: string,
    g: any,
    sink: { written: string[]; removed: string[]; created: string[] }
  ) => {
    g.nodes = (g.nodes ?? []).filter((n: any) => n.id !== "decision:s:a");
    return writeVaultDelta(dir, g, sink);
  };

  await assert.rejects(
    () =>
      applyMutationToVault({
        plan: decisionPlan("sc1", "benign plan, buggy writer"),
        vaultDir: vault,
        stateDir,
        git: true,
        buildIndex: noopIndex,
        writeDelta: buggyWriter,
      }),
    (err: any) => {
      assert.equal(err.check_id, "unexplained-removal");
      assert.equal(err.code, "UNEXPLAINED_REMOVAL");
      assert.deepEqual(err.lost_node_ids, ["decision:s:a"]);
      assert.ok(err.removed_files.some((f: string) => f.includes("A.md")), "消されたファイルを名指しする");
      return true;
    }
  );

  // 巻き戻りの証明: 知識は destroy されていない (完全な旧状態・HEAD 不変)。
  assert.equal(vaultHead(vault), head0);
  assertWriterQuiescent(vault, cacheDir, "self-check");
  assertVaultEquals(vault, snap, "self-check (old side)");
  assert.ok(existsSync(path.join(vault, "Decision", "A.md")), "削除されかけたファイルが復元されている");
});

test("self-check: plan の op:delete による削除は explained — 成功し post_write_check ok", async () => {
  const { repo, vault, stateDir, cacheDir } = gitInitVault();
  seedDecision(repo, vault);
  const res = await applyMutationToVault({
    plan: { reason: "delete decision a", nodes: [{ op: "delete", id: "decision:s:a" }], edges: [] },
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
  });
  assert.equal(res.applied, true);
  assert.deepEqual(res.post_write_check, { id: "unexplained-removal", status: "ok", removed_files: 1 });
  assert.deepEqual(res.cascaded_edge_ids, ["decision_s_a__documented_by__file_s_README.md"]);
  assert.ok(!existsSync(path.join(vault, "Decision", "A.md")));
  assertWriterQuiescent(vault, cacheDir, "self-check delete");
  assert.deepEqual(validateGraph(importVault(vault)), []);
});

test("self-check: rename (title 更新で slug 移動) の旧ファイル削除は explained — 成功する", async () => {
  const { repo, vault, stateDir, cacheDir } = gitInitVault();
  seedDecision(repo, vault);
  const res = await applyMutationToVault({
    plan: {
      reason: "rename decision a",
      nodes: [{ op: "update", id: "decision:s:a", updates: { title: "Renamed Alpha" } }],
      edges: [],
    },
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
  });
  assert.equal(res.applied, true);
  assert.equal(res.post_write_check.status, "ok");
  assert.ok(!existsSync(path.join(vault, "Decision", "A.md")), "旧 slug のファイルは消える");
  assert.ok(existsSync(path.join(vault, "Decision", "Renamed-Alpha.md")), "新 slug に rename される");
  assertWriterQuiescent(vault, cacheDir, "self-check rename");
  assert.deepEqual(validateGraph(importVault(vault)), []);
});
