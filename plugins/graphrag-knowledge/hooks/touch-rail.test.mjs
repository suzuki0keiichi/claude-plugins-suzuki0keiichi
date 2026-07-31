// touch-rail.mjs の単体テスト。
// 実行: node --test hooks/touch-rail.test.mjs
// 方針: ゲート (off 既定 / Edit|Write 以外 / 非実装 / anchor 無し / 既読 fast-path) は無音、
// on + CLI が inject を返した時だけ PreToolUse additionalContext (permissionDecision: allow)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { alreadyTouched } from "./touch-rail.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "touch-rail.mjs");

const runHook = (input, env = {}) =>
  execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, GRAPHRAG_VAULT_DIR: "", GRAPHRAG_RAIL_TOUCH: "", GRAPHRAG_TOUCH_RAIL_CLI: "", ...env }
  });

const makeRepo = (envLines = "") => {
  const root = mkdtempSync(path.join(tmpdir(), "graphrag-touch-rail-"));
  mkdirSync(path.join(root, ".graphrag", "vault"), { recursive: true });
  if (envLines) writeFileSync(path.join(root, ".graphrag", ".env"), envLines);
  return root;
};

const makeStub = (root, result) => {
  const stub = path.join(root, "stub-rail-touch.mjs");
  writeFileSync(stub, `process.stdout.write(${JSON.stringify(JSON.stringify(result))});\n`);
  return stub;
};

const INJECT = { status: "inject", context: "<graphrag touch rail>\nheader\n- [Constraint] x\n</graphrag touch rail>", ids: ["constraint:s:x"], chars: 60 };

const editInput = (root, rel, extra = {}) => ({
  tool_name: "Edit",
  tool_input: { file_path: path.join(root, rel) },
  session_id: "sessT",
  ...extra
});

// ── alreadyTouched (fast-path 純関数) ────────────────────────────────────────

test("alreadyTouched: seen ファイルの touched_files を直接読む。無し/壊れは未読扱い", () => {
  const root = makeRepo();
  const vaultDir = path.join(root, ".graphrag", "vault");
  assert.equal(alreadyTouched(vaultDir, "sessT", "src/a.ts"), false);

  const cacheDir = path.join(root, ".graphrag", "cache");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(path.join(cacheDir, "rail-seen-sessT.json"), JSON.stringify({ touched_files: ["src/a.ts"] }));
  assert.equal(alreadyTouched(vaultDir, "sessT", "src/a.ts"), true);
  assert.equal(alreadyTouched(vaultDir, "sessT", "src/b.ts"), false);

  writeFileSync(path.join(cacheDir, "rail-seen-sessU.json"), "broken json");
  assert.equal(alreadyTouched(vaultDir, "sessU", "src/a.ts"), false);
});

// ── hook 経路 ────────────────────────────────────────────────────────────────

test("off (既定) では無音、on + inject で PreToolUse additionalContext", () => {
  const off = makeRepo();
  assert.equal(
    runHook(editInput(off, "src/pay.ts"), { GRAPHRAG_TOUCH_RAIL_CLI: makeStub(off, INJECT) }).trim(),
    ""
  );

  const on = makeRepo("GRAPHRAG_RAIL_TOUCH=on\n");
  const out = runHook(editInput(on, "src/pay.ts"), { GRAPHRAG_TOUCH_RAIL_CLI: makeStub(on, INJECT) });
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "allow");
  assert.match(parsed.hookSpecificOutput.additionalContext, /graphrag touch rail/);
});

test("Edit|Write 以外・非実装拡張子は無音", () => {
  const root = makeRepo("GRAPHRAG_RAIL_TOUCH=on\n");
  const stub = makeStub(root, INJECT);
  assert.equal(runHook({ ...editInput(root, "src/pay.ts"), tool_name: "Read" }, { GRAPHRAG_TOUCH_RAIL_CLI: stub }).trim(), "");
  assert.equal(runHook(editInput(root, "notes.md"), { GRAPHRAG_TOUCH_RAIL_CLI: stub }).trim(), "");
  assert.equal(runHook(editInput(root, "types.d.ts"), { GRAPHRAG_TOUCH_RAIL_CLI: stub }).trim(), "");
});

test("既読ファイル (fast-path) は spawn せず無音 — stub が inject を返す状態でも出ない", () => {
  const root = makeRepo("GRAPHRAG_RAIL_TOUCH=on\n");
  const cacheDir = path.join(root, ".graphrag", "cache");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(path.join(cacheDir, "rail-seen-sessT.json"), JSON.stringify({ touched_files: ["src/pay.ts"] }));
  const out = runHook(editInput(root, "src/pay.ts"), { GRAPHRAG_TOUCH_RAIL_CLI: makeStub(root, INJECT) });
  assert.equal(out.trim(), "");
});

test("on + silent (CLI 判定) は無音、壊れた CLI 出力も無音 (fail-open)", () => {
  const root = makeRepo("GRAPHRAG_RAIL_TOUCH=on\n");
  assert.equal(
    runHook(editInput(root, "src/pay.ts"), { GRAPHRAG_TOUCH_RAIL_CLI: makeStub(root, { status: "silent", reason: "unwired" }) }).trim(),
    ""
  );
  const broken = path.join(root, "stub-broken.mjs");
  writeFileSync(broken, `process.stdout.write("not-json");\n`);
  assert.equal(runHook(editInput(root, "src/pay.ts"), { GRAPHRAG_TOUCH_RAIL_CLI: broken }).trim(), "");
});

test("anchor 無し (非 graphrag リポジトリ) は無音", () => {
  const bare = mkdtempSync(path.join(tmpdir(), "graphrag-touch-bare-"));
  mkdirSync(path.join(bare, ".git"), { recursive: true });
  const out = runHook(editInput(bare, "src/pay.ts"), { GRAPHRAG_RAIL_TOUCH: "on" });
  assert.equal(out.trim(), "");
});
