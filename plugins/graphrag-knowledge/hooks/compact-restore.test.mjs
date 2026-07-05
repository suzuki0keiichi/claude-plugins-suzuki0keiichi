// compact-restore.mjs の単体テスト (無害化まわり)。
// 実行: node --test hooks/compact-restore.test.mjs
// 注: 注入 happy-path (実 vault からの resume 注入) は vault + CLI を要するため
//     ここでは扱わず、resume 出力の正しさは graphrag/brief.test.ts が担保する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "compact-restore.mjs");

const runHook = (input, env = {}) =>
  execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, ...env }
  });

test("未対応の source では何も出さない (startup)", () => {
  const out = runHook({ hook_event_name: "SessionStart", source: "startup", cwd: process.cwd() });
  assert.equal(out, "");
});

test("未対応の source では何も出さない (resume)", () => {
  const out = runHook({ hook_event_name: "SessionStart", source: "resume", cwd: process.cwd() });
  assert.equal(out, "");
});

test("clear でも .graphrag が見つからなければ何も出さない (非 graphrag リポジトリ)", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "no-graphrag-"));
  try {
    const out = runHook({ hook_event_name: "SessionStart", source: "clear", cwd: empty });
    assert.equal(out, "", "vault の無い場所では clear でも透明");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("clear でも GRAPHRAG_COMPACT_RESTORE=off なら何も出さない", () => {
  const out = runHook(
    { hook_event_name: "SessionStart", source: "clear", cwd: process.cwd() },
    { GRAPHRAG_COMPACT_RESTORE: "off" }
  );
  assert.equal(out, "");
});

test("compact でも .graphrag が見つからなければ何も出さない (非 graphrag リポジトリ)", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "no-graphrag-"));
  try {
    const out = runHook({ hook_event_name: "SessionStart", source: "compact", cwd: empty });
    assert.equal(out, "", "vault の無い場所では透明");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("GRAPHRAG_COMPACT_RESTORE=off で明示 opt-out すると何も出さない", () => {
  // .graphrag があっても env opt-out が勝つことを確認するため cwd はどこでもよい。
  const out = runHook(
    { hook_event_name: "SessionStart", source: "compact", cwd: process.cwd() },
    { GRAPHRAG_COMPACT_RESTORE: "off" }
  );
  assert.equal(out, "");
});

test("入力が不正 JSON でもブロックせず正常終了 (空出力)", () => {
  const out = execFileSync(process.execPath, [SCRIPT], {
    input: "not json at all", encoding: "utf8"
  });
  assert.equal(out, "");
});
