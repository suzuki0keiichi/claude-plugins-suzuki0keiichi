import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendJsonlLog,
  readJsonlLog,
  recordEchoFirings,
  summarizeEchoLog,
  recordEvidenceChanges,
  readEvidenceChangesByPath,
  evidenceStaleNoteForNode,
  ECHO_LOG_FILE,
  EVIDENCE_STALE_FILE
} from "./lane-log.ts";

function tmpCache(): string {
  return mkdtempSync(path.join(tmpdir(), "lane-log-"));
}

test("appendJsonlLog → readJsonlLog: 1行1 JSON round-trip、壊れた行は捨てる", () => {
  const dir = tmpCache();
  appendJsonlLog(dir, "x.jsonl", [{ a: 1 }, { a: 2 }], Date.parse("2026-01-01T00:00:00Z"));
  const fp = path.join(dir, "x.jsonl");
  writeFileSync(fp, readFileSync(fp, "utf8") + "not-json\n");
  appendJsonlLog(dir, "x.jsonl", [{ a: 3 }]);
  const entries = readJsonlLog(dir, "x.jsonl");
  assert.deepEqual(entries.map((e) => e.a), [1, 2, 3]);
  assert.equal(entries[0].ts, "2026-01-01T00:00:00.000Z");
});

test("appendJsonlLog: 存在しない親でもディレクトリを掘って書く / 空 entries は無 IO", () => {
  const dir = path.join(tmpCache(), "deep", "cache");
  appendJsonlLog(dir, "y.jsonl", []);
  assert.equal(readJsonlLog(dir, "y.jsonl").length, 0);
  appendJsonlLog(dir, "y.jsonl", [{ ok: true }]);
  assert.equal(readJsonlLog(dir, "y.jsonl").length, 1);
});

test("summarizeEchoLog: alias 別に発火回数を集計し降順で返す", () => {
  const dir = tmpCache();
  const echo = (alias: string) => [{ alias, knowledge_id: "d:s:x", occurrences: [{ path: "a.ts" }] }];
  recordEchoFirings(dir, echo("hotAlias"), Date.parse("2026-01-01T00:00:00Z"));
  recordEchoFirings(dir, echo("hotAlias"), Date.parse("2026-01-02T00:00:00Z"));
  recordEchoFirings(dir, echo("coldAlias"), Date.parse("2026-01-03T00:00:00Z"));
  const stats = summarizeEchoLog(dir);
  assert.equal(stats.length, 2);
  assert.equal(stats[0].alias, "hotAlias");
  assert.equal(stats[0].firings, 2);
  assert.equal(stats[0].last_fired, "2026-01-02T00:00:00.000Z");
  assert.equal(stats[1].alias, "coldAlias");
});

test("recordEchoFirings: occurrences_overflow を発火回数でなく件数に足し、path は重複排除で ≤3", () => {
  const dir = tmpCache();
  recordEchoFirings(dir, [
    {
      alias: "x_alias",
      knowledge_id: "d:s:x",
      occurrences: [{ path: "a.ts" }, { path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }, { path: "d.ts" }],
      occurrences_overflow: 2
    }
  ]);
  const [entry] = readJsonlLog(dir, ECHO_LOG_FILE);
  assert.equal(entry.occurrences, 7);
  assert.deepEqual(entry.paths, ["a.ts", "b.ts", "c.ts"]);
});

test("recordEvidenceChanges → readEvidenceChangesByPath: path ごとの最終観測時刻", () => {
  const dir = tmpCache();
  recordEvidenceChanges(dir, ["src/a.ts", "src/b.ts"], Date.parse("2026-01-01T00:00:00Z"));
  recordEvidenceChanges(dir, ["src/a.ts"], Date.parse("2026-02-01T00:00:00Z"));
  const byPath = readEvidenceChangesByPath(dir);
  assert.equal(byPath.get("src/a.ts"), "2026-02-01T00:00:00.000Z");
  assert.equal(byPath.get("src/b.ts"), "2026-01-01T00:00:00.000Z");
});

const staleGraph = () => ({
  nodes: [
    {
      id: "ok:s:burn",
      type: "OperationalKnowledge",
      title: "burn",
      generated_at: "2026-01-15T00:00:00.000Z"
    },
    { id: "file:s:src/a.ts", type: "File", path: "src/a.ts" }
  ],
  edges: [{ id: "e1", type: "documented_by", from: "ok:s:burn", to: "file:s:src/a.ts" }]
});

test("evidenceStaleNoteForNode: 検証後に evidence が変わったノードには ⚠ が付く", () => {
  const byPath = new Map([["src/a.ts", "2026-02-01T00:00:00.000Z"]]);
  const note = evidenceStaleNoteForNode("ok:s:burn", staleGraph(), byPath);
  assert.ok(note, "note should be attached");
  assert.equal(note!.verified_at, "2026-01-15T00:00:00.000Z");
  assert.deepEqual(note!.paths, [{ path: "src/a.ts", changed_at: "2026-02-01T00:00:00.000Z" }]);
  assert.match(note!.note, /changed AFTER/);
});

test("evidenceStaleNoteForNode: 変更が検証より古い / generated_at 無し / 台帳空 は null", () => {
  const olderChange = new Map([["src/a.ts", "2026-01-01T00:00:00.000Z"]]);
  assert.equal(evidenceStaleNoteForNode("ok:s:burn", staleGraph(), olderChange), null);

  const g = staleGraph();
  delete (g.nodes[0] as any).generated_at;
  const newerChange = new Map([["src/a.ts", "2026-02-01T00:00:00.000Z"]]);
  assert.equal(evidenceStaleNoteForNode("ok:s:burn", g, newerChange), null);

  assert.equal(evidenceStaleNoteForNode("ok:s:burn", staleGraph(), new Map()), null);
});

test("evidenceStaleNoteForNode: File ノード欠損でも id 規約 file:<system>:<path> から復元", () => {
  const g = {
    nodes: [{ id: "ok:s:burn", type: "OperationalKnowledge", generated_at: "2026-01-15T00:00:00.000Z" }],
    edges: [{ id: "e1", type: "documented_by", from: "ok:s:burn", to: "file:s:src/a.ts" }]
  };
  const byPath = new Map([["src/a.ts", "2026-02-01T00:00:00.000Z"]]);
  const note = evidenceStaleNoteForNode("ok:s:burn", g, byPath);
  assert.ok(note);
  assert.equal(note!.paths[0].path, "src/a.ts");
});

test("EVIDENCE_STALE_FILE / ECHO_LOG_FILE は別ファイル (相互汚染しない)", () => {
  const dir = tmpCache();
  recordEvidenceChanges(dir, ["src/a.ts"]);
  recordEchoFirings(dir, [{ alias: "x_alias", knowledge_id: "d:s:x", occurrences: [] }]);
  assert.equal(readJsonlLog(dir, EVIDENCE_STALE_FILE).length, 1);
  assert.equal(readJsonlLog(dir, ECHO_LOG_FILE).length, 1);
  assert.equal(summarizeEchoLog(dir).length, 1);
});

// ── 猶予窓と git 裏取り (レビュー指摘 #5) ───────────────────────────────────
import { execFileSync } from "node:child_process";
import { refuteEvidenceChangeViaGit, EVIDENCE_STALE_GRACE_MS_DEFAULT } from "./lane-log.ts";

test("猶予窓: 検証直後 (2h 以内) の変更観測は stale にしない — 書き戻し→commit の順序反転対策", () => {
  const byPath = new Map([["src/a.ts", "2026-01-15T01:30:00.000Z"]]); // 検証の 1.5h 後
  assert.equal(evidenceStaleNoteForNode("ok:s:burn", staleGraph(), byPath), null);
  const past = new Map([["src/a.ts", "2026-01-15T03:00:00.000Z"]]); // 3h 後 → 猶予外
  assert.ok(evidenceStaleNoteForNode("ok:s:burn", staleGraph(), past));
  // graceMs override
  assert.ok(
    evidenceStaleNoteForNode("ok:s:burn", staleGraph(), byPath, undefined, { graceMs: 0 }),
    "graceMs:0 なら即 stale"
  );
  assert.ok(EVIDENCE_STALE_GRACE_MS_DEFAULT > 0);
});

test("refuteEvidenceChangeViaGit: revert 済み (worktree クリーン & 検証以後の commit 無し) は refute、生きている変更は keep", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "lane-git-"));
  const g = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(path.join(repo, "a.ts"), "one\n");
  g("add", "a.ts");
  g("commit", "-q", "-m", "c1");

  const future = "2099-01-01T00:00:00.000Z"; // 検証がファイル最終 commit より新しい
  assert.equal(refuteEvidenceChangeViaGit(repo, "a.ts", future), true, "検証以後 commit 無し + クリーン → refute");

  writeFileSync(path.join(repo, "a.ts"), "dirty\n");
  assert.equal(refuteEvidenceChangeViaGit(repo, "a.ts", future), false, "worktree に変更が生きている → keep");

  g("add", "a.ts");
  g("commit", "-q", "-m", "c2");
  const past = "2000-01-01T00:00:00.000Z"; // 検証がファイル最終 commit より古い
  assert.equal(refuteEvidenceChangeViaGit(repo, "a.ts", past), false, "検証後に commit が実在 → keep");

  assert.equal(refuteEvidenceChangeViaGit("/nonexistent-root", "a.ts", past), false, "git 不能は fail-open (keep)");
});
