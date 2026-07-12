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
  assert.deepEqual(sink.created, shards, "新規シャードは created に載る");
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
