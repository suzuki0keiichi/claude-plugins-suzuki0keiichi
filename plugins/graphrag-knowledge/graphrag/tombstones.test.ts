import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendTombstones,
  latestTombstones,
  readTombstones,
  resolveSuccessor,
  tombstoneShardRel,
  TOMBSTONES_DIR,
  type TombstoneEntry,
} from "./tombstones.ts";

const entry = (over: Partial<TombstoneEntry> & { id: string }): TombstoneEntry => ({
  deleted_at: "2026-07-13T00:00:00.000Z",
  reason: "test delete",
  ...over,
});

test("tombstoneShardRel: deleted_at の年月でシャードを割る / 非 ISO は明示エラー", () => {
  assert.equal(tombstoneShardRel("2026-07-13T01:02:03Z"), path.join(TOMBSTONES_DIR, "2026-07.jsonl"));
  assert.throws(() => tombstoneShardRel("not-a-date"), /not ISO 8601/);
});

test("appendTombstones: 追記され readTombstones で読める。sink に written/created が積まれる", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tomb-"));
  const sink = { written: [] as string[], created: [] as string[] };
  const shards = appendTombstones(dir, [entry({ id: "doc:n1", type: "Risk", title: "旧" })], sink);
  assert.equal(shards.length, 1);
  assert.ok(sink.created.includes(shards[0]), "新規シャードは created に載る");
  assert.ok(
    sink.created.includes(path.join(TOMBSTONES_DIR, ".gitattributes")),
    "初回は merge=union の .gitattributes も created に載る (同一 commit で確定)"
  );
  // 2 回目の追記は created に載らない (既存ファイル)
  const sink2 = { written: [] as string[], created: [] as string[] };
  appendTombstones(dir, [entry({ id: "doc:n2" })], sink2);
  assert.equal(sink2.written.length, 1);
  assert.equal(sink2.created.length, 0);
  const read = readTombstones(dir);
  assert.equal(read.errors.length, 0);
  assert.deepEqual(read.entries.map((e) => e.id), ["doc:n1", "doc:n2"]);
});

test("latestTombstones: 同一 id は後発が勝つ (successor の後追記)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tomb-"));
  appendTombstones(dir, [entry({ id: "doc:n1" })]);
  appendTombstones(dir, [entry({ id: "doc:n1", successor: "doc:h9" })]);
  const latest = latestTombstones(dir);
  assert.equal(latest.get("doc:n1")?.successor, "doc:h9");
});

test("readTombstones: 壊れた行と必須フィールド欠落は errors に載り、他の行は生きる", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tomb-"));
  appendTombstones(dir, [entry({ id: "doc:ok" })]);
  const shard = path.join(dir, TOMBSTONES_DIR, "2026-07.jsonl");
  appendFileSync(shard, "{ broken json\n" + JSON.stringify({ id: "doc:bad" }) + "\n");
  const read = readTombstones(dir);
  assert.equal(read.entries.length, 1);
  assert.equal(read.errors.length, 2);
});

test("resolveSuccessor: チェーンを畳む / successor 無しは final null / 循環は打ち切る", () => {
  const map = new Map<string, TombstoneEntry>([
    ["a", entry({ id: "a", successor: "b" })],
    ["b", entry({ id: "b", successor: "c" })],
  ]);
  const r = resolveSuccessor(map, "a");
  assert.equal(r.final_successor, "c");
  assert.deepEqual(r.chain, ["a", "b", "c"]);
  assert.equal(r.cycle, false);

  assert.equal(resolveSuccessor(new Map([["x", entry({ id: "x" })]]), "x").final_successor, null);

  const cyc = new Map<string, TombstoneEntry>([
    ["a", entry({ id: "a", successor: "b" })],
    ["b", entry({ id: "b", successor: "a" })],
  ]);
  const rc = resolveSuccessor(cyc, "a");
  assert.equal(rc.cycle, true);
});

test("台帳が無い vault は空を返す (読み取り経路が新規 vault で落ちない)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tomb-"));
  assert.equal(existsSync(path.join(dir, TOMBSTONES_DIR)), false);
  assert.deepEqual(readTombstones(dir), { entries: [], errors: [] });
  assert.equal(latestTombstones(dir).size, 0);
});

// ── merge=union: 利用者が台帳の競合マーカーを見ないための装置 ──────────────────

test("appendTombstones: .gitattributes (merge=union) を自動同梱し sink にも積む", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tomb-"));
  const sink = { written: [] as string[], created: [] as string[] };
  appendTombstones(dir, [entry({ id: "doc:n1" })], sink);
  const ga = path.join(dir, TOMBSTONES_DIR, ".gitattributes");
  assert.ok(existsSync(ga));
  assert.match(readFileSync(ga, "utf8"), /\*\.jsonl merge=union/);
  assert.ok(sink.created.includes(path.join(TOMBSTONES_DIR, ".gitattributes")));
  // 2回目は再作成しない
  const sink2 = { written: [] as string[], created: [] as string[] };
  appendTombstones(dir, [entry({ id: "doc:n2" })], sink2);
  assert.ok(!sink2.written.some((p) => p.endsWith(".gitattributes")));
});

test("git merge: 別ブランチが同一シャードへ追記しても union で競合にならず両側の行が残る", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "tomb-merge-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  // main: 初回 append (= .gitattributes ごと commit される)
  appendTombstones(repo, [entry({ id: "doc:base", deleted_at: "2026-07-01T00:00:00.000Z" })]);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  // ブランチ側: doc:y を追記
  git("checkout", "-q", "-b", "side");
  appendTombstones(repo, [entry({ id: "doc:y", deleted_at: "2026-07-03T00:00:00.000Z" })]);
  git("add", "-A");
  git("commit", "-q", "-m", "side delete");
  // main 側: doc:x を追記 (同一シャード末尾 = 素の git なら競合する形)
  git("checkout", "-q", "main");
  appendTombstones(repo, [entry({ id: "doc:x", deleted_at: "2026-07-02T00:00:00.000Z", successor: "doc:x2" })]);
  git("add", "-A");
  git("commit", "-q", "-m", "main delete");
  // merge: 競合なしで成功すること (union が両側の行を残す)
  git("merge", "-q", "--no-edit", "side");
  const read = readTombstones(repo);
  assert.equal(read.errors.length, 0, "競合マーカーが混入しない");
  assert.deepEqual(
    [...read.entries.map((e) => e.id)].sort(),
    ["doc:base", "doc:x", "doc:y"],
    "両ブランチの削除記録が両方残る"
  );
});

test("latestTombstones: 解決は行順でなく deleted_at (union の行順揺れに耐える)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tomb-"));
  // 新しいエントリ (successor 持ち) を先に、古いエントリを後に書く = 行順が時系列と逆
  appendTombstones(dir, [entry({ id: "doc:a", deleted_at: "2026-07-05T00:00:00.000Z", successor: "doc:a2" })]);
  appendTombstones(dir, [entry({ id: "doc:a", deleted_at: "2026-07-01T00:00:00.000Z" })]);
  const latest = latestTombstones(dir);
  assert.equal(latest.get("doc:a")?.successor, "doc:a2", "deleted_at が新しい方が勝つ");
  // 同時刻なら successor 持ちが勝つ (301 情報を落とさない)
  appendTombstones(dir, [
    entry({ id: "doc:b", deleted_at: "2026-07-06T00:00:00.000Z", successor: "doc:b2" }),
    entry({ id: "doc:b", deleted_at: "2026-07-06T00:00:00.000Z" }),
  ]);
  assert.equal(latestTombstones(dir).get("doc:b")?.successor, "doc:b2");
});
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
