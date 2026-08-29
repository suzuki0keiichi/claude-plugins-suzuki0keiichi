// read-rail.mjs の単体テスト。
// 実行: node --test hooks/read-rail.test.mjs
// 方針: ゲート (off 既定 / Read 以外 / 非実装 / anchor 無し / 既読 fast-path) は無音、
// on + CLI が inject を返した時だけ PostToolUse additionalContext。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "read-rail.mjs");

const runHook = (input, env = {}) =>
  execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, GRAPHRAG_VAULT_DIR: "", GRAPHRAG_RAIL_READ: "", GRAPHRAG_READ_RAIL_CLI: "", ...env }
  });

const makeRepo = (envLines = "") => {
  const root = mkdtempSync(path.join(tmpdir(), "graphrag-read-rail-"));
  mkdirSync(path.join(root, ".graphrag", "vault"), { recursive: true });
  if (envLines) writeFileSync(path.join(root, ".graphrag", ".env"), envLines);
  return root;
};

const makeStub = (root, result) => {
  const stub = path.join(root, "stub-rail-read.mjs");
  writeFileSync(stub, `process.stdout.write(${JSON.stringify(JSON.stringify(result))});\n`);
  return stub;
};

const INJECT = { status: "inject", context: "<graphrag read rail>\nheader\n- [Constraint] x\n</graphrag read rail>", ids: ["constraint:s:x"], chars: 58 };

const readInput = (root, rel, extra = {}) => ({
  tool_name: "Read",
  tool_input: { file_path: path.join(root, rel) },
  session_id: "sessR",
  ...extra
});

test("off (既定) では無音、on + inject で PostToolUse additionalContext", () => {
  const off = makeRepo();
  assert.equal(
    runHook(readInput(off, "src/pay.ts"), { GRAPHRAG_READ_RAIL_CLI: makeStub(off, INJECT) }).trim(),
    ""
  );

  const on = makeRepo("GRAPHRAG_RAIL_READ=on\n");
  const out = runHook(readInput(on, "src/pay.ts"), { GRAPHRAG_READ_RAIL_CLI: makeStub(on, INJECT) });
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(parsed.hookSpecificOutput.additionalContext, /graphrag read rail/);
});

test("Read 以外・非実装拡張子は無音", () => {
  const root = makeRepo("GRAPHRAG_RAIL_READ=on\n");
  const stub = makeStub(root, INJECT);
  assert.equal(runHook({ ...readInput(root, "src/pay.ts"), tool_name: "Edit" }, { GRAPHRAG_READ_RAIL_CLI: stub }).trim(), "");
  assert.equal(runHook(readInput(root, "notes.md"), { GRAPHRAG_READ_RAIL_CLI: stub }).trim(), "");
  assert.equal(runHook(readInput(root, "types.d.ts"), { GRAPHRAG_READ_RAIL_CLI: stub }).trim(), "");
});

test("既読ファイル (read_files fast-path) は spawn せず無音", () => {
  const root = makeRepo("GRAPHRAG_RAIL_READ=on\n");
  const cacheDir = path.join(root, ".graphrag", "cache");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(path.join(cacheDir, "rail-seen-sessR.json"), JSON.stringify({ read_files: ["src/pay.ts"] }));
  const out = runHook(readInput(root, "src/pay.ts"), { GRAPHRAG_READ_RAIL_CLI: makeStub(root, INJECT) });
  assert.equal(out.trim(), "");
});

test("touch レールの touched_files では抑制されない (レール別の既読)", () => {
  const root = makeRepo("GRAPHRAG_RAIL_READ=on\n");
  const cacheDir = path.join(root, ".graphrag", "cache");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(path.join(cacheDir, "rail-seen-sessR.json"), JSON.stringify({ touched_files: ["src/pay.ts"] }));
  const out = runHook(readInput(root, "src/pay.ts"), { GRAPHRAG_READ_RAIL_CLI: makeStub(root, INJECT) });
  assert.match(out, /graphrag read rail/);
});

test("on + silent (CLI 判定) は無音、壊れた CLI 出力も無音 (fail-open)", () => {
  const root = makeRepo("GRAPHRAG_RAIL_READ=on\n");
  assert.equal(
    runHook(readInput(root, "src/pay.ts"), { GRAPHRAG_READ_RAIL_CLI: makeStub(root, { status: "silent", reason: "unwired" }) }).trim(),
    ""
  );
  const broken = path.join(root, "stub-broken.mjs");
  writeFileSync(broken, `process.stdout.write("not-json");\n`);
  assert.equal(runHook(readInput(root, "src/pay.ts"), { GRAPHRAG_READ_RAIL_CLI: broken }).trim(), "");
});

test("anchor 無し (非 graphrag リポジトリ) は無音", () => {
  const bare = mkdtempSync(path.join(tmpdir(), "graphrag-read-bare-"));
  mkdirSync(path.join(bare, ".git"), { recursive: true });
  const out = runHook(readInput(bare, "src/pay.ts"), { GRAPHRAG_RAIL_READ: "on" });
  assert.equal(out.trim(), "");
});
