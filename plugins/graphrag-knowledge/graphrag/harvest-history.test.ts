import assert from "node:assert/strict";
import test from "node:test";
import {
  extractRevertCandidates,
  extractMarkerCandidates,
  harvestHistory,
  runHarvestHistory,
  isRevertCommit,
  revertedSubject,
  suggestSlug,
  type GitCommit
} from "./harvest-history.ts";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// --- 合成データ (git 不要・決定論的) --------------------------------------------

const COMMITS: GitCommit[] = [
  { hash: "a1".repeat(20), date: "2026-06-01", subject: "feat: add retry queue", body: "" },
  {
    hash: "b2".repeat(20),
    date: "2026-06-02",
    subject: 'Revert "feat: add retry queue"',
    body: "This reverts commit a1a1a1.\n\nflaky in production"
  },
  {
    hash: "c3".repeat(20),
    date: "2026-06-03",
    subject: 'Revert "Revert "feat: add retry queue""',
    body: "This reverts commit b2b2b2."
  },
  {
    // subject に Revert が無くても body の定型文で拾う (squash 等で subject が変わる場合)
    hash: "d4".repeat(20),
    date: "2026-06-04",
    subject: "戻す: キャッシュ層の導入",
    body: "This reverts commit 999999.\n"
  },
  { hash: "e5".repeat(20), date: "2026-06-05", subject: "fix: typo", body: "" }
];

const FILES: Record<string, string | null> = {
  "src/auth.ts": [
    "export function login() {",
    "  // HACK: トークン更新が間に合わない時があるので 2 回リトライする",
    "  retry();",
    "}",
    "// FIXME 期限切れ判定が UTC 前提",
    ""
  ].join("\n"),
  "src/pay.ts": "// 通常のコメントだけ\nexport const x = 1;\n",
  "assets/logo.png": null, // バイナリ → 走査対象外
  "src/queue.ts": "// WORKAROUND: broker 再接続中は enqueue を握りつぶす\n// XXX ここ怪しい\n"
};

function fakeDeps() {
  return {
    gitLog: (_root: string) => COMMITS,
    gitLsFiles: (_root: string) => Object.keys(FILES),
    readFile: (absPath: string) => {
      const rel = path.relative("/repo", absPath);
      return FILES[rel] ?? null;
    }
  };
}

// --- revert 抽出 -----------------------------------------------------------------

test("isRevertCommit detects subject prefix and body boilerplate", () => {
  assert.equal(isRevertCommit(COMMITS[1]), true);
  assert.equal(isRevertCommit(COMMITS[3]), true); // body のみで判定
  assert.equal(isRevertCommit(COMMITS[0]), false);
  assert.equal(isRevertCommit(COMMITS[4]), false);
});

test("revertedSubject unwraps nested Revert quoting", () => {
  assert.equal(revertedSubject('Revert "feat: add retry queue"'), "feat: add retry queue");
  assert.equal(revertedSubject('Revert "Revert "feat: add retry queue""'), "feat: add retry queue");
  assert.equal(revertedSubject("戻す: キャッシュ層の導入"), "戻す: キャッシュ層の導入");
});

test("extractRevertCandidates groups reverts of the same original subject", () => {
  const candidates = extractRevertCandidates(COMMITS);
  assert.equal(candidates.length, 2);
  const retry = candidates.find((c) => c.title.includes("feat: add retry queue"))!;
  // revert と re-revert が同じ束 (試して戻すを繰り返した跡が 1 candidate に)
  assert.equal(retry.commits.length, 2);
  assert.deepEqual(retry.commits.map((c) => c.date), ["2026-06-02", "2026-06-03"]);
  assert.equal(retry.suggested_slug, "feat-add-retry-queue");
  assert.ok(retry.note.length > 0);
  for (const c of retry.commits) {
    assert.ok(c.hash && c.subject && c.date); // {hash, subject, date} の形を保つ
  }
});

test("suggestSlug falls back when the subject has no ascii (Japanese subjects)", () => {
  assert.equal(suggestSlug("戻す: キャッシュ層の導入", "reverted-d4d4d4d4"), "reverted-d4d4d4d4");
  assert.equal(suggestSlug("Fix  the   Thing!!", "x"), "fix-the-thing");
});

// --- マーカー抽出 ------------------------------------------------------------------

test("extractMarkerCandidates finds HACK/FIXME/WORKAROUND/XXX with 1-based lines", () => {
  const deps = fakeDeps();
  const found = extractMarkerCandidates("/repo", deps.gitLsFiles("/repo"), deps.readFile);
  assert.deepEqual(
    found.map((c) => [c.path, c.line, c.marker]),
    [
      ["src/auth.ts", 2, "HACK"],
      ["src/auth.ts", 5, "FIXME"],
      ["src/queue.ts", 1, "WORKAROUND"],
      ["src/queue.ts", 2, "XXX"]
    ]
  );
  assert.match(found[0].text, /トークン更新/);
  // バイナリ (readFile が null) とマーカー無しファイルは出ない
  assert.ok(found.every((c) => c.path !== "assets/logo.png" && c.path !== "src/pay.ts"));
});

// --- 本体 / CLI -------------------------------------------------------------------

test("harvestHistory returns candidate JSON in the concern-hint style", () => {
  const result = harvestHistory({ root: "/repo", system: "payments" }, fakeDeps());
  assert.equal(result.generated_by, "graphrag/harvest-history.ts");
  assert.equal(result.root, "/repo");
  assert.equal(result.system, "payments");
  assert.equal(result.revert_candidates.suggested_type, "RejectedOption");
  assert.equal(result.revert_candidates.count, 2);
  assert.equal(result.marker_candidates.suggested_type, "OperationalKnowledge | Risk");
  assert.equal(result.marker_candidates.count, 4);
  assert.match(result.note, /typed-add/); // 確定は LLM、というコントラクトを出力自身が言う
});

test("runHarvestHistory requires --root and writes --out when given", () => {
  assert.throws(() => runHarvestHistory([], fakeDeps()), /--root/);
  const dir = mkdtempSync(path.join(tmpdir(), "grag-harvest-"));
  try {
    const outPath = path.join(dir, "harvest.json");
    const result = runHarvestHistory(
      ["--root", "/repo", "--system", "payments", "--out", outPath],
      fakeDeps()
    );
    const onDisk = JSON.parse(readFileSync(outPath, "utf8"));
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(result)));
    assert.equal(onDisk.system, "payments");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
