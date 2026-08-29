// 内部敵対レビュー (mutate-vault 分) の red→green テスト群。
//
// 指摘A [P1]: 回復失敗 (crashResidue=true の run が begin 後の分岐で失敗) が、引き受けた
//   前世代の crash residue (write journal + 奇数 seq) を finally で焼却し、以後 torn が
//   二度と吸収されない。→ 失敗経路では residue を前世代の内容のまま保全する。
// 指摘B [P1]: journal がパス名だけで内容の裏取りが無く、crash 後の人手編集が dirty 免除 +
//   吸収 stage を素通りして commit に混入する。→ journal を {path, sha256(intended)} に
//   拡張し、現 worktree 内容が intended と一致するエントリだけを torn と認める。
// 指摘D [P2]: pathspec が wildmatch 解釈され、`[` 入りタイトル由来のファイル名
//   (slugifyTitle は `[]` を落とさない) が文字クラスとして解釈され、glob 一致する無関係
//   ファイルを stage してしまう。→ 全 pathspec に :(literal) を付与する。
// 指摘F [P3]: git 操作検出が merge/cherry-pick/revert のみで、rebase/bisect/squash/am が
//   素通りまたは検出 (detached) が begin/journal より後。→ 検出対象を拡充し最上流へ。
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildVaultFiles } from "./build-vault.ts";
import {
  applyMutationToVault,
  writeVaultDelta,
  vaultHead,
  readVaultWriteJournal,
  writeVaultWriteJournal,
  vaultWriteJournalPath,
} from "./mutate-vault.ts";
import { readSeq, beginVaultWrite, readVaultConsistent } from "./vault-lock.ts";

const FIXED_TS = "2026-01-01T00:00:00.000Z";
const noopIndex = async () => ({ stubbed: true });

function gitInitVault(): { repo: string; vault: string; stateDir: string; cacheDir: string } {
  const repo = mkdtempSync(path.join(tmpdir(), "vadv-"));
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

/** 既存 Decision A + documented_by README を追加 seed して commit した repo。 */
function gitInitVaultWithDecision(): { repo: string; vault: string; stateDir: string; cacheDir: string } {
  const ctx = gitInitVault();
  for (const f of buildVaultFiles(decisionAGraph("a"))) {
    const abs = path.join(ctx.vault, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  execFileSync("git", ["-C", ctx.repo, "add", "."]);
  execFileSync("git", ["-C", ctx.repo, "commit", "-q", "-m", "seed decision"]);
  return ctx;
}

function decisionAGraph(summary: string) {
  return {
    generated_at: FIXED_TS,
    nodes: [
      { id: "file:s:README.md", type: "File", title: "README.md", path: "README.md" },
      { id: "decision:s:a", type: "Decision", title: "A", summary },
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
}

/** Decision/A.md の canonical 内容 (summary だけ差し替えた round-trip する変種)。 */
function editedDecisionAContent(summary: string): string {
  const f = buildVaultFiles(decisionAGraph(summary)).find((f) => f.relPath === "Decision/A.md");
  assert.ok(f, "前提: Decision/A.md が生成される");
  return f!.content;
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

function committedFiles(repo: string): string {
  return execFileSync("git", ["-C", repo, "show", "--name-only", "--format=", "HEAD"], {
    encoding: "utf8",
  });
}

function currentBranch(repo: string): string {
  return execFileSync("git", ["-C", repo, "symbolic-ref", "--short", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

/** 前 writer の crash 再現: begin (奇数 seq) → torn ノード書き込み → journal 残し。 */
function simulateTornCrash(vault: string, cacheDir: string): { began: number; tornWritten: string[] } {
  mkdirSync(cacheDir, { recursive: true });
  const began = beginVaultWrite(cacheDir);
  assert.equal(began % 2, 1, "前提: 書込窓が開いたまま (seq 奇数)");
  const tornGraph = {
    generated_at: FIXED_TS,
    nodes: [
      { id: "file:s:README.md", type: "File", title: "README.md", path: "README.md" },
      { id: "decision:s:torn", type: "Decision", title: "Torn", summary: "written but never committed" },
    ],
    edges: [
      {
        id: "decision_s_torn__documented_by__file_s_README.md",
        type: "documented_by",
        from: "decision:s:torn",
        to: "file:s:README.md",
      },
    ],
  };
  const delta = writeVaultDelta(vault, tornGraph);
  assert.ok(delta.written.includes(path.join("Decision", "Torn.md")), "前提: torn ファイルが書かれた");
  writeVaultWriteJournal(cacheDir, journalEntriesFromWorktree(vault, delta.written), began);
  return { began, tornWritten: delta.written };
}

// ── journal 内容打刻ヘルパ (指摘B: intended = 実際に書いた内容) ────────────────
import { createHash } from "node:crypto";
function sha256Of(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
function journalEntriesFromWorktree(vault: string, rels: string[]) {
  // 実 writer と同じ形の journal エントリ: intended = いま worktree に書いてある内容
  // (crash 再現では「書いた直後に kill された」= 現内容がそのまま intended)。
  return rels.map((rel) => {
    const abs = path.join(vault, rel);
    return {
      path: rel.split(path.sep).join("/"),
      sha256: existsSync(abs) ? sha256Of(readFileSync(abs, "utf8")) : null,
    };
  });
}

// ── 指摘A ────────────────────────────────────────────────────────────────────

test("指摘A: 回復 run の失敗 (PRESTAGED_WIP_BLOCKED) は引き受けた crash residue を焼かない", async () => {
  const { repo, vault, stateDir, cacheDir } = gitInitVault();
  const head0 = vaultHead(vault);
  const { began } = simulateTornCrash(vault, cacheDir);

  // 利用者の事前 staged WIP (journal 外パス): 回復 mutation は gitCommitVault の
  // PRESTAGED_WIP_BLOCKED で失敗する — begin 後・journal merge 後の失敗分岐。
  writeFileSync(path.join(vault, "NOTES.txt"), "user staged wip\n");
  execFileSync("git", ["add", "--", "NOTES.txt"], { cwd: vault });

  await assert.rejects(
    () =>
      applyMutationToVault({
        plan: decisionPlan("reca", "recovery blocked by prestaged wip"),
        vaultDir: vault,
        stateDir,
        git: true,
        buildIndex: noopIndex,
      }),
    (err: any) => err.code === "PRESTAGED_WIP_BLOCKED"
  );

  // residue は焼かれない: seq は奇数のまま、journal は前世代の内容で残る。
  assert.equal(readSeq(cacheDir) % 2, 1, "seq は奇数のまま (crash 痕跡を保全)");
  const journal = readVaultWriteJournal(cacheDir);
  assert.ok(journal, "journal は残る (前世代の回復材料)");
  assert.equal(journal!.seq, began, "打刻 seq は前世代の奇数のまま");
  assert.ok(JSON.stringify(journal).includes("Torn.md"), "前世代の torn path 記載を保持する");
  assert.equal(vaultHead(vault), head0, "HEAD 不変");
  assert.ok(existsSync(path.join(vault, "Decision", "Torn.md")), "torn ファイルは worktree に残る");

  // 利用者が WIP を退けたら、次の mutation が torn を吸収して自己回復する。
  execFileSync("git", ["restore", "--staged", "--", "NOTES.txt"], { cwd: vault });
  const res = await applyMutationToVault({
    plan: decisionPlan("recb", "second recovery succeeds"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
  });
  assert.equal(res.applied, true);
  const committed = committedFiles(repo);
  assert.ok(committed.includes("Decision/Torn.md"), "torn は次の回復で吸収 commit される");
  assert.ok(committed.includes("Decision/RECB.md"), "mutation 自身の差分も commit される");
  assert.equal(readSeq(cacheDir) % 2, 0, "書込窓は閉じて回復");
  assert.ok(!existsSync(vaultWriteJournalPath(cacheDir)), "journal は成功後に削除される");
});

test("指摘A: 回復失敗が残す residue (seq 奇数 + lock 不在) でも読みは詰まらない", async () => {
  // 失敗した回復 run は lock を解放して residue (奇数 seq) を残す。writer は必ず lock
  // 取得後に beginVaultWrite するので「奇数 seq + lock 不在」に生きた writer は居ない —
  // 読み手はこれを crash residue の静的状態として読めなければならない (詰まると
  // residue 保全 (指摘A) が読み手全員を 10s timeout に道連れにする)。
  const stateDir = mkdtempSync(path.join(tmpdir(), "vadv-seq-"));
  beginVaultWrite(stateDir); // 奇数 seq、lock ファイルは無い
  const start = Date.now();
  const got = await readVaultConsistent(stateDir, () => "DATA", { timeoutMs: 3000, pollMs: 5 });
  assert.equal(got, "DATA", "residue の静的状態を読んで返す");
  assert.ok(Date.now() - start < 1500, "timeout を待たず速やかに読める");
});

// ── 指摘B ────────────────────────────────────────────────────────────────────

test("指摘B: crash 後に手編集された journal 記載パスは dirty 免除されず DIRTY_VAULT_WIP_BLOCKED", async () => {
  const { vault, stateDir, cacheDir } = gitInitVaultWithDecision();
  mkdirSync(cacheDir, { recursive: true });
  const head0 = vaultHead(vault);

  // crash 再現: 前 writer が Decision/A.md へ torn 内容 X を書いた直後に kill。
  const began = beginVaultWrite(cacheDir);
  assert.equal(began % 2, 1);
  const tornX = editedDecisionAContent("torn content from crashed writer");
  writeFileSync(path.join(vault, "Decision", "A.md"), tornX);
  writeVaultWriteJournal(cacheDir, journalEntriesFromWorktree(vault, ["Decision/A.md"]), began);

  // crash 後・回復前の人手編集 (X → Y): journal 記載パスだが内容は intended と別物。
  const humanY = editedDecisionAContent("human tampered after crash");
  assert.notEqual(humanY, tornX);
  writeFileSync(path.join(vault, "Decision", "A.md"), humanY);

  // A.md を書く mutation: journal 記載パスというだけで dirty 免除してはいけない。
  await assert.rejects(
    () =>
      applyMutationToVault({
        plan: {
          reason: "update a while journal path was hand-edited",
          nodes: [{ op: "update", id: "decision:s:a", updates: { state: "superseded" } }],
          edges: [],
        },
        vaultDir: vault,
        stateDir,
        git: true,
        buildIndex: noopIndex,
      }),
    (err: any) => {
      assert.equal(err.code, "DIRTY_VAULT_WIP_BLOCKED");
      assert.ok(err.dirty_paths.includes(path.join("Decision", "A.md")));
      return true;
    }
  );
  assert.equal(vaultHead(vault), head0, "HEAD 不変");
  assert.equal(
    readFileSync(path.join(vault, "Decision", "A.md"), "utf8"),
    humanY,
    "人手編集は上書きも吸収もされない"
  );
  // 拒否は begin 前 (dirty 事前検査) なので residue はそのまま残る。
  assert.equal(readSeq(cacheDir) % 2, 1, "crash 痕跡 (奇数 seq) は保存される");
  assert.ok(existsSync(vaultWriteJournalPath(cacheDir)), "journal も保存される");
});

test("指摘B: 手編集された journal 記載パスは無関係 mutation の crash 吸収にも入らない", async () => {
  const { repo, vault, stateDir, cacheDir } = gitInitVaultWithDecision();
  mkdirSync(cacheDir, { recursive: true });

  // crash 再現: journal は Decision/A.md を intended 内容 X (torn) で記載。
  const began = beginVaultWrite(cacheDir);
  assert.equal(began % 2, 1);
  const tornX = editedDecisionAContent("torn content from crashed writer");
  writeFileSync(path.join(vault, "Decision", "A.md"), tornX);
  writeVaultWriteJournal(cacheDir, journalEntriesFromWorktree(vault, ["Decision/A.md"]), began);

  // crash 後の人手編集 (X → Y)。canonical variant なので delta には載らない。
  const humanY = editedDecisionAContent("human tampered after crash");
  writeFileSync(path.join(vault, "Decision", "A.md"), humanY);

  // 無関係な回復 mutation: A.md は触らない。journal 記載でも内容不一致なら吸収しない。
  const res = await applyMutationToVault({
    plan: decisionPlan("recc", "unrelated recovery must not absorb tampered file"),
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
  });
  assert.equal(res.applied, true);
  const committed = committedFiles(repo);
  assert.ok(committed.includes("Decision/RECC.md"), "mutation 自身の差分は commit される");
  assert.ok(!committed.includes("Decision/A.md"), "人手編集された journal 記載パスは吸収 commit されない");
  assert.equal(
    readFileSync(path.join(vault, "Decision", "A.md"), "utf8"),
    humanY,
    "人手編集は worktree に残る"
  );
  const porcelain = execFileSync("git", ["status", "--porcelain", "--", "."], {
    cwd: vault,
    encoding: "utf8",
  });
  assert.match(porcelain, /Decision\/A\.md/, "編集は dirty のまま可視 (fsck git-uncommitted が拾う)");
});

// ── 指摘D ────────────────────────────────────────────────────────────────────

test("指摘D: `[` 入りタイトル由来のファイル名でも正しいファイルだけが stage/commit される", async () => {
  const { repo, vault, stateDir } = gitInitVault();
  // 文字クラス解釈 `[WIP]` = W|I|P で glob 一致してしまう decoy ノード W-Hotfix を
  // commit 済みで用意し、利用者の手編集 (canonical variant) で dirty にしておく。
  const decoyGraph = (summary: string) => ({
    generated_at: FIXED_TS,
    nodes: [
      { id: "file:s:README.md", type: "File", title: "README.md", path: "README.md" },
      { id: "decision:s:decoy", type: "Decision", title: "W Hotfix", summary },
    ],
    edges: [
      {
        id: "decision_s_decoy__documented_by__file_s_README.md",
        type: "documented_by",
        from: "decision:s:decoy",
        to: "file:s:README.md",
      },
    ],
  });
  for (const f of buildVaultFiles(decoyGraph("decoy"))) {
    const abs = path.join(vault, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed decoy"]);
  const decoyEdited = buildVaultFiles(decoyGraph("decoy edited by user")).find(
    (f) => f.relPath === "Decision/W-Hotfix.md"
  )!.content;
  writeFileSync(path.join(vault, "Decision", "W-Hotfix.md"), decoyEdited);

  // `[` 入りタイトルのノードを作る mutation (slugifyTitle は `[]` を落とさない)。
  const plan = {
    reason: "bracket title node",
    nodes: [
      { op: "create", id: "decision:s:wip-hotfix", type: "Decision", title: "[WIP] Hotfix", summary: "bracket" },
      { op: "create", id: "file:s:src/wip.ts", type: "File", title: "wip.ts", path: "src/wip.ts" },
    ],
    edges: [
      {
        op: "create",
        id: "decision_s_wip-hotfix__documented_by__file_s_src_wip.ts",
        type: "documented_by",
        from: "decision:s:wip-hotfix",
        to: "file:s:src/wip.ts",
      },
    ],
  };
  const res = await applyMutationToVault({
    plan,
    vaultDir: vault,
    stateDir,
    git: true,
    buildIndex: noopIndex,
  });
  assert.equal(res.applied, true);
  assert.ok(
    existsSync(path.join(vault, "Decision", "[WIP]-Hotfix.md")),
    "前提: ノードファイル名に [] が残る"
  );

  const committed = committedFiles(repo);
  assert.ok(committed.includes("Decision/[WIP]-Hotfix.md"), "mutation 自身のファイルは commit される");
  assert.ok(
    !committed.includes("Decision/W-Hotfix.md"),
    "文字クラス解釈で glob 一致する decoy は stage/commit されない"
  );
  assert.equal(
    readFileSync(path.join(vault, "Decision", "W-Hotfix.md"), "utf8"),
    decoyEdited,
    "decoy の手編集は無傷 (worktree に残る)"
  );
  const porcelain = execFileSync("git", ["status", "--porcelain", "--", "."], {
    cwd: vault,
    encoding: "utf8",
  });
  assert.match(porcelain, /W-Hotfix\.md/, "decoy の編集は dirty のまま可視");
});

// ── 指摘F ────────────────────────────────────────────────────────────────────

test("指摘F: rebase 進行中 (conflict 停止) の mutation は begin/journal より前に拒否される", async () => {
  const { repo, vault, stateDir, cacheDir } = gitInitVault();
  const base = currentBranch(repo);
  // vault 外のファイルで衝突する rebase を作り conflict で停止させる。
  writeFileSync(path.join(repo, "conflict.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "conflict.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base file"]);
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "topic"]);
  writeFileSync(path.join(repo, "conflict.txt"), "topic\n");
  execFileSync("git", ["-C", repo, "commit", "-q", "-am", "topic change"]);
  execFileSync("git", ["-C", repo, "checkout", "-q", base]);
  writeFileSync(path.join(repo, "conflict.txt"), "main\n");
  execFileSync("git", ["-C", repo, "commit", "-q", "-am", "main change"]);
  execFileSync("git", ["-C", repo, "checkout", "-q", "topic"]);
  try {
    execFileSync("git", ["-C", repo, "rebase", base], { stdio: "pipe" });
    assert.fail("前提: rebase は conflict で停止するはず");
  } catch {
    /* expected */
  }
  assert.ok(existsSync(path.join(repo, ".git", "rebase-merge")), "前提: rebase-merge が存在");

  await assert.rejects(
    () =>
      applyMutationToVault({
        plan: decisionPlan("rb", "mutation during rebase"),
        vaultDir: vault,
        stateDir,
        git: true,
        buildIndex: noopIndex,
      }),
    (err: any) => {
      assert.equal(err.code, "OPERATION_IN_PROGRESS_BLOCKED");
      assert.equal(err.operation, "rebase");
      assert.match(err.message, /rebase --continue/);
      assert.match(err.message, /rebase --abort/);
      return true;
    }
  );
  assert.equal(readSeq(cacheDir), 0, "書込窓は開かれない (begin/journal より前に拒否)");
  assert.ok(!existsSync(vaultWriteJournalPath(cacheDir)), "journal は書かれない");
  assert.ok(!existsSync(path.join(vault, "Decision", "RB.md")), "vault には何も書かれない");
  assert.ok(existsSync(path.join(repo, ".git", "rebase-merge")), "rebase 状態は無傷");
});

test("指摘F: bisect 進行中の mutation は拒否される", async () => {
  const { repo, vault, stateDir, cacheDir } = gitInitVault();
  const head0 = vaultHead(vault);
  execFileSync("git", ["-C", repo, "bisect", "start"], { stdio: "pipe" });
  assert.ok(existsSync(path.join(repo, ".git", "BISECT_LOG")), "前提: BISECT_LOG が存在");

  await assert.rejects(
    () =>
      applyMutationToVault({
        plan: decisionPlan("bi", "mutation during bisect"),
        vaultDir: vault,
        stateDir,
        git: true,
        buildIndex: noopIndex,
      }),
    (err: any) => {
      assert.equal(err.code, "OPERATION_IN_PROGRESS_BLOCKED");
      assert.equal(err.operation, "bisect");
      return true;
    }
  );
  assert.equal(vaultHead(vault), head0, "HEAD 不変 (bisect 中に commit しない)");
  assert.equal(readSeq(cacheDir), 0, "書込窓は開かれない");
  assert.ok(!existsSync(path.join(vault, "Decision", "BI.md")), "何も書かれない");
  assert.ok(existsSync(path.join(repo, ".git", "BISECT_LOG")), "bisect 状態は無傷");
});

test("指摘F: squash merge 未確定 (SQUASH_MSG) 中の mutation は拒否される", async () => {
  const { repo, vault, stateDir, cacheDir } = gitInitVault();
  const base = currentBranch(repo);
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "sq-topic"]);
  writeFileSync(path.join(vault, "squash-note.txt"), "from topic\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "topic adds vault file"]);
  execFileSync("git", ["-C", repo, "checkout", "-q", base]);
  execFileSync("git", ["-C", repo, "merge", "--squash", "sq-topic"], { stdio: "pipe" });
  assert.ok(existsSync(path.join(repo, ".git", "SQUASH_MSG")), "前提: SQUASH_MSG が存在");
  const stagedBefore = execFileSync("git", ["-C", repo, "diff", "--cached", "--name-only"], {
    encoding: "utf8",
  }).trim();
  assert.match(stagedBefore, /squash-note\.txt/, "前提: squash 結果が staged");

  await assert.rejects(
    () =>
      applyMutationToVault({
        plan: decisionPlan("sq", "mutation during squash merge"),
        vaultDir: vault,
        stateDir,
        git: true,
        buildIndex: noopIndex,
      }),
    (err: any) => {
      assert.equal(err.code, "OPERATION_IN_PROGRESS_BLOCKED");
      assert.match(String(err.operation), /squash/);
      return true;
    }
  );
  assert.equal(readSeq(cacheDir), 0, "書込窓は開かれない");
  assert.ok(!existsSync(path.join(vault, "Decision", "SQ.md")), "何も書かれない");
  assert.ok(existsSync(path.join(repo, ".git", "SQUASH_MSG")), "squash 状態は無傷");
  const stagedAfter = execFileSync("git", ["-C", repo, "diff", "--cached", "--name-only"], {
    encoding: "utf8",
  }).trim();
  assert.equal(stagedAfter, stagedBefore, "squash の staged 状態も無傷");
});

test("指摘F: git am 進行中 (patch 適用失敗で停止) の mutation は拒否される", async () => {
  const { repo, vault, stateDir, cacheDir } = gitInitVault();
  const base = currentBranch(repo);
  writeFileSync(path.join(repo, "am-target.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "am-target.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "am base"]);
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "am-topic"]);
  writeFileSync(path.join(repo, "am-target.txt"), "patched\n");
  execFileSync("git", ["-C", repo, "commit", "-q", "-am", "patch change"]);
  const patch = execFileSync("git", ["-C", repo, "format-patch", "-1", "--stdout"], {
    encoding: "utf8",
  });
  execFileSync("git", ["-C", repo, "checkout", "-q", base]);
  writeFileSync(path.join(repo, "am-target.txt"), "diverged\n");
  execFileSync("git", ["-C", repo, "commit", "-q", "-am", "diverge"]);
  try {
    execFileSync("git", ["-C", repo, "am"], { input: patch, stdio: ["pipe", "pipe", "pipe"] });
    assert.fail("前提: git am は適用失敗で停止するはず");
  } catch {
    /* expected */
  }
  assert.ok(existsSync(path.join(repo, ".git", "rebase-apply")), "前提: rebase-apply が存在");
  const head0 = vaultHead(vault);

  await assert.rejects(
    () =>
      applyMutationToVault({
        plan: decisionPlan("gam", "mutation during git am"),
        vaultDir: vault,
        stateDir,
        git: true,
        buildIndex: noopIndex,
      }),
    (err: any) => {
      assert.equal(err.code, "OPERATION_IN_PROGRESS_BLOCKED");
      assert.equal(err.operation, "am");
      return true;
    }
  );
  assert.equal(vaultHead(vault), head0, "HEAD 不変 (am 中に commit しない)");
  assert.equal(readSeq(cacheDir), 0, "書込窓は開かれない");
  assert.ok(!existsSync(path.join(vault, "Decision", "GAM.md")), "何も書かれない");
  assert.ok(existsSync(path.join(repo, ".git", "rebase-apply")), "am 状態は無傷");
});
