// clear-restore.mjs の単体テスト。
// 実行: node --test hooks/clear-restore.test.mjs
// 予約キー方式: ask-state.json の __checkpoint__ キーを clear で one-shot 消費して注入する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "clear-restore.mjs");
const CHECKPOINT_KEY = "__checkpoint__";

const runHook = (input, env = {}) =>
  execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, ...env }
  });

// 既定レイアウト <root>/.graphrag/vault の一時 fixture。
const makeAnchor = () => {
  const root = mkdtempSync(path.join(tmpdir(), "graphrag-ckpt-"));
  mkdirSync(path.join(root, ".graphrag", "vault"), { recursive: true });
  return root;
};

const askStatePath = (root) => path.join(root, ".graphrag", "cache", "ask-state.json");

// state (キー群) を ask-state.json に書く。
const writeState = (root, state) => {
  const fp = askStatePath(root);
  mkdirSync(path.dirname(fp), { recursive: true });
  writeFileSync(fp, JSON.stringify(state, null, 2));
  return fp;
};

// 標準的な checkpoint 予約キー entry。marked_at / cwd を差し替えて各判定を試す。
const checkpointEntry = (over = {}) => ({
  count: 0,
  last_at: Date.now(),
  marked_at: new Date().toISOString(),
  cwd: over.cwd ?? "__PLACEHOLDER__",
  investigation_id: "investigation:s:live",
  first_action: "foo.ts:42 の bar() を直す",
  work_state: "current focus: X\nnext: foo.ts:42 の bar() を直す\nblocker: なし",
  ...over
});

// --- 無害化 / 無音系 ---

test("startup では何も出さない", () => {
  assert.equal(runHook({ source: "startup", cwd: process.cwd() }), "");
});

test("resume では何も出さない", () => {
  assert.equal(runHook({ source: "resume", cwd: process.cwd() }), "");
});

test("compact はキーが在っても無音かつキーを消費しない", () => {
  const root = makeAnchor();
  try {
    const fp = writeState(root, { [CHECKPOINT_KEY]: checkpointEntry({ cwd: root }) });
    const out = runHook({ source: "compact", cwd: root });
    assert.equal(out, "", "compact では復元しない");
    const onDisk = JSON.parse(readFileSync(fp, "utf8"));
    assert.ok(onDisk[CHECKPOINT_KEY], "compact は予約キーを消費しない (clear まで残す)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear でも .graphrag が見つからなければ無音", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "no-graphrag-"));
  try {
    assert.equal(runHook({ source: "clear", cwd: empty }), "");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("clear でも GRAPHRAG_CLEAR_RESTORE=off なら無音", () => {
  const root = makeAnchor();
  try {
    writeState(root, { [CHECKPOINT_KEY]: checkpointEntry({ cwd: root }) });
    const out = runHook({ source: "clear", cwd: root }, { GRAPHRAG_CLEAR_RESTORE: "off" });
    assert.equal(out, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("入力が不正 JSON でもブロックせず無音", () => {
  const out = execFileSync(process.execPath, [SCRIPT], { input: "not json at all", encoding: "utf8" });
  assert.equal(out, "");
});

test("clear + ask-state.json 無しは無音", () => {
  const root = makeAnchor();
  try {
    assert.equal(runHook({ source: "clear", cwd: root }), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear + 予約キー無しは無音 (他キーが在っても)", () => {
  const root = makeAnchor();
  try {
    const fp = writeState(root, { abcd1234: { count: 2, last_at: 111 } });
    assert.equal(runHook({ source: "clear", cwd: root }), "");
    // 予約キーが無いだけなので消費 (書き戻し) はしない。
    const onDisk = JSON.parse(readFileSync(fp, "utf8"));
    assert.deepEqual(onDisk.abcd1234, { count: 2, last_at: 111 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear + ask-state.json 破損は無音", () => {
  const root = makeAnchor();
  try {
    const fp = askStatePath(root);
    mkdirSync(path.dirname(fp), { recursive: true });
    writeFileSync(fp, "{ broken json");
    assert.equal(runHook({ source: "clear", cwd: root }), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- 復元 happy-path / 失効・cwd 判定 ---

test("clear + 新鮮な予約キー: 注入され・キーは消え・他キーは残る", () => {
  const root = makeAnchor();
  try {
    const fp = writeState(root, {
      [CHECKPOINT_KEY]: checkpointEntry({ cwd: root }),
      abcd1234: { count: 2, last_at: 111 }
    });
    const out = runHook({ source: "clear", cwd: root });
    const parsed = JSON.parse(out);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(ctx, /foo\.ts:42 の bar\(\) を直す/, "first_action が含まれる");
    assert.match(ctx, /current focus: X/, "work_state が含まれる");
    assert.match(ctx, /investigation:s:live/, "出所 Investigation id が含まれる");

    const onDisk = JSON.parse(readFileSync(fp, "utf8"));
    assert.ok(!(CHECKPOINT_KEY in onDisk), "予約キーは one-shot 消費される");
    assert.deepEqual(onDisk.abcd1234, { count: 2, last_at: 111 }, "他キーは残る");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear + cwd が symlink 経由で表記違い: 実体パス一致なら復元する", () => {
  // 実バグの回帰: checkpoint-mark の process.cwd() は OS 解決済み (/private/var/…) だが、
  // フック input.cwd は未解決 (/var/…) で届き得る。素の文字列比較だと偽陰性で弾いていた。
  const root = makeAnchor();
  try {
    const resolved = realpathSync(root); // macOS では /var/… → /private/var/… に解決される
    const fp = writeState(root, {
      [CHECKPOINT_KEY]: checkpointEntry({ cwd: resolved })
    });
    const out = runHook({ source: "clear", cwd: root }); // 未解決表記で渡す
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /自動復元/, "表記違いでも実体が同じなら復元される");
    const onDisk = JSON.parse(readFileSync(fp, "utf8"));
    assert.ok(!(CHECKPOINT_KEY in onDisk), "消費される");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear + 失効 (60分超): 理由一行を注入しキーを消費", () => {
  const root = makeAnchor();
  try {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const fp = writeState(root, {
      [CHECKPOINT_KEY]: checkpointEntry({ cwd: root, marked_at: old, last_at: Date.now() - 2 * 60 * 60 * 1000 })
    });
    const out = runHook({ source: "clear", cwd: root });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /復元しなかった/);
    assert.match(ctx, /失効窓/);
    const onDisk = JSON.parse(readFileSync(fp, "utf8"));
    assert.ok(!(CHECKPOINT_KEY in onDisk), "失効でも one-shot 消費される");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear + cwd 不一致: 理由一行を注入しキーを消費", () => {
  const root = makeAnchor();
  try {
    const fp = writeState(root, {
      [CHECKPOINT_KEY]: checkpointEntry({ cwd: "/somewhere/else" })
    });
    const out = runHook({ source: "clear", cwd: root });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /復元しなかった/);
    assert.match(ctx, /別ディレクトリ/);
    assert.match(ctx, /\/somewhere\/else/);
    const onDisk = JSON.parse(readFileSync(fp, "utf8"));
    assert.ok(!(CHECKPOINT_KEY in onDisk), "cwd 不一致でも one-shot 消費される");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
