// compact-restore.mjs の単体テスト (無害化まわり)。
// 実行: node --test hooks/compact-restore.test.mjs
// 注: 注入 happy-path (実 vault からの resume 注入) は vault + CLI を要するため
//     ここでは扱わず、resume 出力の正しさは graphrag/brief.test.ts が担保する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// --- one-shot マーカー (checkpoint-pending.json) ---
// 注入 happy-path は実 vault を要するため扱わない (先頭コメント参照)。
// ここで担保するのは「マーカーの消費 (one-shot) と失効判定」。

// 既定レイアウト <root>/.graphrag/vault の一時 fixture (vault は空 = 復元対象なし)。
const makeAnchorFixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "graphrag-marker-"));
  mkdirSync(path.join(root, ".graphrag", "vault"), { recursive: true });
  return root;
};

const writeMarker = (root, markedAt) => {
  const fp = path.join(root, ".graphrag", "cache", "checkpoint-pending.json");
  mkdirSync(path.dirname(fp), { recursive: true });
  writeFileSync(fp, JSON.stringify({ marked_at: new Date(markedAt).toISOString() }));
  return fp;
};

test("clear: 失効したマーカーは消費して白紙 (復元しない)", () => {
  const root = makeAnchorFixture();
  try {
    const fp = writeMarker(root, Date.now() - 2 * 60 * 60 * 1000); // 2 時間前 (> TTL 60 分)
    const out = runHook({ hook_event_name: "SessionStart", source: "clear", cwd: root });
    assert.equal(out, "", "失効した意図では復元しない");
    assert.equal(existsSync(fp), false, "失効マーカーも one-shot で消費される");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear: 新鮮なマーカーは消費される (10 分より古い checkpoint でも復元経路に乗る)", () => {
  const root = makeAnchorFixture();
  try {
    // 30 分前 = 旧 10 分ゲートでは弾かれるが、マーカー TTL (60 分) 内。
    const fp = writeMarker(root, Date.now() - 30 * 60 * 1000);
    const out = runHook({ hook_event_name: "SessionStart", source: "clear", cwd: root });
    // vault が空なので注入自体は無い (primary 無し → 無音) が、
    // マーカーが消費されている = 失効 return ではなく復元経路に入った証拠。
    assert.equal(out, "");
    assert.equal(existsSync(fp), false, "新鮮なマーカーは復元経路で消費される");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compact: 残っているマーカーを片付ける (後日の無関係な /clear での二重復元防止)", () => {
  const root = makeAnchorFixture();
  try {
    const fp = writeMarker(root, Date.now());
    const out = runHook({ hook_event_name: "SessionStart", source: "compact", cwd: root });
    assert.equal(out, "", "vault が空なら注入は無い");
    assert.equal(existsSync(fp), false, "compact 消費でもマーカーは片付く");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear: マーカー無しは従来どおり (generated_at 旧ゲートに落ち、空 vault では無音)", () => {
  const root = makeAnchorFixture();
  try {
    const out = runHook({ hook_event_name: "SessionStart", source: "clear", cwd: root });
    assert.equal(out, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
