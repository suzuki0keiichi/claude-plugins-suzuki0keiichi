// prompt-rail.mjs の単体テスト。
// 実行: node --test hooks/prompt-rail.test.mjs
// 方針: ゲート (off 既定 / anchor 無し / 短文 / スラッシュコマンド) は無音、
// on + CLI が inject を返した時だけ additionalContext。CLI は GRAPHRAG_PROMPT_RAIL_CLI で stub。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { railEnabled } from "./prompt-rail.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompt-rail.mjs");

const runHook = (input, env = {}) =>
  execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, GRAPHRAG_VAULT_DIR: "", GRAPHRAG_RAIL_PROMPT: "", GRAPHRAG_PROMPT_RAIL_CLI: "", ...env }
  });

const makeRepo = (envLines = "") => {
  const root = mkdtempSync(path.join(tmpdir(), "graphrag-prompt-rail-"));
  mkdirSync(path.join(root, ".graphrag", "vault"), { recursive: true });
  if (envLines) writeFileSync(path.join(root, ".graphrag", ".env"), envLines);
  return root;
};

const makeStub = (root, result) => {
  const stub = path.join(root, "stub-rail-prompt.mjs");
  writeFileSync(stub, `process.stdout.write(${JSON.stringify(JSON.stringify(result))});\n`);
  return stub;
};

const INJECT = { status: "inject", context: "<graphrag prompt rail>\nheader\n- [Decision] x\n</graphrag prompt rail>", ids: ["decision:s:x"], chars: 60 };

// ── railEnabled (純関数) ─────────────────────────────────────────────────────

test("railEnabled: 既定は off、.env の on で opt-in、シェル env が最優先", () => {
  const off = makeRepo();
  assert.equal(railEnabled("GRAPHRAG_RAIL_PROMPT", off), false);

  const on = makeRepo("GRAPHRAG_RAIL_PROMPT=on\n");
  assert.equal(railEnabled("GRAPHRAG_RAIL_PROMPT", on), true);

  process.env.GRAPHRAG_RAIL_PROMPT = "off";
  try {
    assert.equal(railEnabled("GRAPHRAG_RAIL_PROMPT", on), false, "シェル env の off が .env の on に勝つ");
  } finally {
    delete process.env.GRAPHRAG_RAIL_PROMPT;
  }
});

// ── hook 経路 ────────────────────────────────────────────────────────────────

test("off (既定) では stub があっても無音", () => {
  const root = makeRepo();
  const out = runHook(
    { prompt: "checkpoint の復元が効かないので調べたい", cwd: root, session_id: "s1" },
    { GRAPHRAG_PROMPT_RAIL_CLI: makeStub(root, INJECT) }
  );
  assert.equal(out.trim(), "");
});

test("on + inject で additionalContext を UserPromptSubmit 形式で出す", () => {
  const root = makeRepo("GRAPHRAG_RAIL_PROMPT=on\n");
  const out = runHook(
    { prompt: "checkpoint の復元が効かないので調べたい", cwd: root, session_id: "s1" },
    { GRAPHRAG_PROMPT_RAIL_CLI: makeStub(root, INJECT) }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(parsed.hookSpecificOutput.additionalContext, /graphrag prompt rail/);
});

test("on + silent (CLI 判定) は無音", () => {
  const root = makeRepo("GRAPHRAG_RAIL_PROMPT=on\n");
  const out = runHook(
    { prompt: "checkpoint の復元が効かないので調べたい", cwd: root, session_id: "s1" },
    { GRAPHRAG_PROMPT_RAIL_CLI: makeStub(root, { status: "silent", reason: "low-confidence" }) }
  );
  assert.equal(out.trim(), "");
});

test("短文・スラッシュコマンドは spawn 前に無音 (stub 不在でもエラーにならない)", () => {
  const root = makeRepo("GRAPHRAG_RAIL_PROMPT=on\n");
  assert.equal(runHook({ prompt: "短い", cwd: root }).trim(), "");
  assert.equal(runHook({ prompt: "/graphrag-knowledge:graphrag-checkpoint 実行", cwd: root }).trim(), "");
});

test("anchor 無し (非 graphrag リポジトリ) は無音", () => {
  const bare = mkdtempSync(path.join(tmpdir(), "graphrag-prompt-bare-"));
  mkdirSync(path.join(bare, ".git"), { recursive: true });
  const out = runHook(
    { prompt: "checkpoint の復元が効かないので調べたい", cwd: bare, session_id: "s1" },
    { GRAPHRAG_RAIL_PROMPT: "on" }
  );
  assert.equal(out.trim(), "");
});

test("CLI が壊れた JSON を返しても無音で終了する (fail-open)", () => {
  const root = makeRepo("GRAPHRAG_RAIL_PROMPT=on\n");
  const stub = path.join(root, "stub-broken.mjs");
  writeFileSync(stub, `process.stdout.write("not-json");\n`);
  const out = runHook(
    { prompt: "checkpoint の復元が効かないので調べたい", cwd: root, session_id: "s1" },
    { GRAPHRAG_PROMPT_RAIL_CLI: stub }
  );
  assert.equal(out.trim(), "");
});
