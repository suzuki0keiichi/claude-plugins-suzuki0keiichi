// edit-observe.mjs の単体テスト。
// 実行: node --test hooks/edit-observe.test.mjs
// 方針: GRAPHRAG_RAIL_READ=on の間だけ、実装ファイルの Edit/Write を rail-log.jsonl に
// {rail:"edit-observe"} で1行追記する。注入は一切しない (stdout 無音)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "edit-observe.mjs");

const runHook = (input, env = {}) =>
  execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, GRAPHRAG_VAULT_DIR: "", GRAPHRAG_RAIL_READ: "", ...env }
  });

const makeRepo = (envLines = "") => {
  const root = mkdtempSync(path.join(tmpdir(), "graphrag-edit-observe-"));
  mkdirSync(path.join(root, ".graphrag", "vault"), { recursive: true });
  if (envLines) writeFileSync(path.join(root, ".graphrag", ".env"), envLines);
  return root;
};

const editInput = (root, rel, tool = "Edit") => ({
  tool_name: tool,
  tool_input: { file_path: path.join(root, rel) },
  session_id: "sessE"
});

const logPath = (root) => path.join(root, ".graphrag", "cache", "rail-log.jsonl");

test("on で Edit/Write を rail-log に記録する (stdout は無音)", () => {
  const root = makeRepo("GRAPHRAG_RAIL_READ=on\n");
  assert.equal(runHook(editInput(root, "src/pay.ts")).trim(), "");
  assert.equal(runHook(editInput(root, "src/pay.ts", "Write")).trim(), "");
  const lines = readFileSync(logPath(root), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].rail, "edit-observe");
  assert.equal(lines[0].file, "src/pay.ts");
  assert.equal(lines[0].session, "sessE");
});

test("off (既定) では記録しない", () => {
  const root = makeRepo();
  runHook(editInput(root, "src/pay.ts"));
  assert.equal(existsSync(logPath(root)), false);
});

test("非実装拡張子・Edit/Write 以外は記録しない", () => {
  const root = makeRepo("GRAPHRAG_RAIL_READ=on\n");
  runHook(editInput(root, "notes.md"));
  runHook({ ...editInput(root, "src/pay.ts"), tool_name: "Read" });
  assert.equal(existsSync(logPath(root)), false);
});
