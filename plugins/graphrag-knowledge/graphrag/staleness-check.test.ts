import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildVaultFiles } from "./build-vault.ts";
import { stalenessCheck, runStalenessCheck } from "./staleness-check.ts";

// 合成 graph → 本物の vault ファイルに書いてから読む (generated_at の banner
// round-trip を含めて、実運用と同じ経路で検証する)。
// build-vault は banner に必ず stamp を入れるため、「generated_at 無し」は
// banner-less の legacy ファイルでのみ起こる — bannerlessIds で banner 行を
// 落としてその状態を再現する。
function writeVaultFromGraph(graph: Record<string, unknown>, bannerlessIds: string[] = []): string {
  const dir = mkdtempSync(path.join(tmpdir(), "grag-stale-vault-"));
  for (const f of buildVaultFiles(graph as any)) {
    const abs = path.join(dir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    let content = f.content;
    if (bannerlessIds.some((id) => content.includes(`id: "${id}"`))) {
      content = content
        .split("\n")
        .filter((line) => !line.includes("source snapshot:"))
        .join("\n");
    }
    writeFileSync(abs, content);
  }
  return dir;
}

const GRAPH = {
  nodes: [
    { id: "file:sys:src/auth.ts", type: "File", title: "auth", path: "src/auth.ts", generated_at: "2026-01-01T00:00:00.000Z" },
    { id: "file:sys:src/pay.ts", type: "File", title: "pay", path: "src/pay.ts", generated_at: "2026-01-01T00:00:00.000Z" },
    {
      id: "decision:sys:token-refresh",
      type: "Decision",
      title: "トークン更新は二重化する",
      summary: "要約",
      generated_at: "2026-02-01T00:00:00.000Z"
    },
    {
      id: "constraint:sys:no-sync-io",
      type: "Constraint",
      title: "決済経路で同期 IO 禁止",
      summary: "要約",
      generated_at: "2026-03-01T00:00:00.000Z"
    },
    {
      // generated_at 無し (banner-less legacy) → 基準時刻が測れないので skipped に数えるだけ
      id: "operationalknowledge:sys:no-stamp",
      type: "OperationalKnowledge",
      title: "stamp 無しの知識",
      summary: "要約"
    },
    {
      id: "investigation:sys:not-target",
      type: "Investigation",
      title: "調査は対象外",
      summary: "要約",
      raw_content: "raw",
      generated_at: "2026-02-01T00:00:00.000Z"
    }
  ],
  edges: [
    { id: "e1", type: "documented_by", from: "decision:sys:token-refresh", to: "file:sys:src/auth.ts" },
    // 同じ (node, path) への別種エッジは 1 回しか数えない
    { id: "e2", type: "sets_policy_for", from: "decision:sys:token-refresh", to: "file:sys:src/auth.ts" },
    { id: "e3", type: "constrains", from: "constraint:sys:no-sync-io", to: "file:sys:src/pay.ts" },
    { id: "e4", type: "documented_by", from: "operationalknowledge:sys:no-stamp", to: "file:sys:src/pay.ts" },
    { id: "e5", type: "documented_by", from: "investigation:sys:not-target", to: "file:sys:src/auth.ts" }
  ]
};

// 合成 git: path と since ごとに返すコミット列を固定 (新しい順)
function fakeGit(calls?: { since: string; path: string }[]) {
  return {
    gitLogSince: (_root: string, since: string, filePath: string) => {
      calls?.push({ since, path: filePath });
      if (filePath === "src/auth.ts") {
        return [
          { hash: "f6f6", subject: "refactor: token refresh を一本化" },
          { hash: "e5e5", subject: "fix: refresh race" },
          { hash: "d4d4", subject: "feat: oidc" },
          { hash: "c3c3", subject: "chore: lint" },
          { hash: "b2b2", subject: "fix: ヘッダ欠落" }
        ];
      }
      if (filePath === "src/pay.ts") {
        return [{ hash: "a1a1", subject: "fix: 丸め誤差" }];
      }
      return [];
    }
  };
}

test("stalenessCheck lists knowledge nodes whose evidenced files moved on without them", () => {
  const vaultDir = writeVaultFromGraph(GRAPH, ["operationalknowledge:sys:no-stamp"]);
  try {
    const calls: { since: string; path: string }[] = [];
    const result = stalenessCheck(
      { vaultDir, root: "/repo", thresholdCommits: 5 },
      fakeGit(calls)
    );
    assert.equal(result.candidate_count, 1);
    assert.deepEqual(result.candidates[0], {
      node_id: "decision:sys:token-refresh",
      node_title: "トークン更新は二重化する",
      file_path: "src/auth.ts",
      commits_since: 5,
      last_commit_subject: "refactor: token refresh を一本化"
    });
    // Decision×auth.ts (重複エッジは 1 回) + Constraint×pay.ts の 2 ペアだけ git を見る
    assert.equal(result.pairs_checked, 2);
    assert.equal(calls.filter((c) => c.path === "src/auth.ts").length, 1);
    // since にはノードの generated_at がそのまま渡る
    assert.equal(calls.find((c) => c.path === "src/auth.ts")?.since, "2026-02-01T00:00:00.000Z");
    assert.equal(calls.find((c) => c.path === "src/pay.ts")?.since, "2026-03-01T00:00:00.000Z");
    // generated_at 無しは黙って消さず件数で可視化
    assert.equal(result.skipped_no_generated_at, 1);
    assert.match(result.note, /audit/);
  } finally {
    rmSync(vaultDir, { recursive: true, force: true });
  }
});

test("stalenessCheck respects --threshold-commits (below threshold is not a candidate)", () => {
  const vaultDir = writeVaultFromGraph(GRAPH, ["operationalknowledge:sys:no-stamp"]);
  try {
    const strict = stalenessCheck({ vaultDir, root: "/repo", thresholdCommits: 1 }, fakeGit());
    assert.deepEqual(
      strict.candidates.map((c) => [c.node_id, c.commits_since]),
      [
        ["decision:sys:token-refresh", 5],
        ["constraint:sys:no-sync-io", 1]
      ]
    );
    const loose = stalenessCheck({ vaultDir, root: "/repo", thresholdCommits: 6 }, fakeGit());
    assert.equal(loose.candidate_count, 0);
    assert.equal(loose.pairs_checked, 2); // 候補ゼロでも見たペア数は正直に出す
  } finally {
    rmSync(vaultDir, { recursive: true, force: true });
  }
});

test("runStalenessCheck resolves vault from flag and parses threshold (default 5)", () => {
  const vaultDir = writeVaultFromGraph(GRAPH, ["operationalknowledge:sys:no-stamp"]);
  try {
    const result = runStalenessCheck(["--vault", vaultDir, "--root", "/repo"], fakeGit());
    assert.equal(result.threshold_commits, 5);
    assert.equal(result.vault_dir, vaultDir);
    assert.equal(result.root, "/repo");
    const strict = runStalenessCheck(
      ["--vault", vaultDir, "--root", "/repo", "--threshold-commits", "1"],
      fakeGit()
    );
    assert.equal(strict.threshold_commits, 1);
    assert.equal(strict.candidate_count, 2);
  } finally {
    rmSync(vaultDir, { recursive: true, force: true });
  }
});

test("runStalenessCheck fails loudly without a vault", () => {
  const prev = process.env.GRAPHRAG_VAULT_DIR;
  delete process.env.GRAPHRAG_VAULT_DIR;
  try {
    assert.throws(() => runStalenessCheck(["--root", "/repo"], fakeGit()), /GRAPHRAG_VAULT_DIR|--vault/);
  } finally {
    if (prev !== undefined) process.env.GRAPHRAG_VAULT_DIR = prev;
  }
});
