// proactive-persistence-reminder.mjs の単体テスト。
// 実行: node --test hooks/proactive-persistence-reminder.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "proactive-persistence-reminder.mjs");

const runHook = (stdinText) =>
  execFileSync(process.execPath, [SCRIPT], { input: stdinText, encoding: "utf8" });

const hookInput = (command) =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

const EXPECTED = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    additionalContext:
      "<graphrag write-back check, on commit boundary: (1) Have you written back the adoption decision behind this change, the alternatives you rejected, the risks you hit, and the operational gotchas? If not, write them back via add-* right after the commit (run the duplicate pre-check first). (2) If this focus is now settled, include an op:update setting its active Investigation to state:closed in the same write-back plan — no other natural closing trigger exists; this commit boundary IS the closing moment.>",
  },
};

test("git commit を含むコマンドでリマインダ JSON を stdout に出す", () => {
  const out = runHook(hookInput('git commit -m "feat: 何か"'));
  assert.deepEqual(JSON.parse(out), EXPECTED);
});

test("複合コマンド中の git commit も検出する", () => {
  const out = runHook(hookInput("git add -A && git commit -m 'fix'"));
  assert.deepEqual(JSON.parse(out), EXPECTED);
});

test("グローバルオプション介在 (git -C <dir> commit) も検出する", () => {
  const out = runHook(hookInput("git -C /tmp/repo commit --amend"));
  assert.deepEqual(JSON.parse(out), EXPECTED);
});

test("git commit を含まないコマンドでは何も出さない", () => {
  assert.equal(runHook(hookInput("git status && git diff")), "");
});

test("コミットメッセージ等のクォート内文字列には反応しない", () => {
  assert.equal(runHook(hookInput('echo "あとで git commit すること"')), "");
  assert.equal(runHook(hookInput("git log --grep 'git commit'")), "");
});

test("単語境界 — git commitlint / mygit commit には反応しない", () => {
  assert.equal(runHook(hookInput("git commitlint --edit")), "");
  assert.equal(runHook(hookInput("mygit commit -m x")), "");
});

test("tool_input.command が無い入力では何も出さない", () => {
  assert.equal(runHook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} })), "");
  assert.equal(runHook(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" } })), "");
});

test("不正な JSON 入力でも何も出さず exit 0 (非ブロッキング)", () => {
  assert.equal(runHook("not-json{{{"), "");
});
