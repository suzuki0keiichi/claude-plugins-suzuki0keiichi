#!/usr/bin/env node
// ファイル読み取り時の読みレール (PostToolUse / Read)。
// いま読んだファイルに配線済みの知識 (rail-touch と同じ逆引き文法) を、方針がコンテキストに
// 堆積する前 (= 初回 Read の直後) に additionalContext で届ける。touch レール (書き込み直前
// advisory) は正常性バイアスで手遅れと裁定され停止 — 同じ逆引きを届ける時刻だけ前に移した後継。
// 判定・dedup・ログは CLI 側 (graphrag/rail-read.ts)。ここは薄い spawn ラッパ +
// 「同一ファイルは同一セッションで一度だけ」の fast-path (seen の read_files を直接読み、
// 既読なら spawn せず即終了 — 毎 Read にコストを払わない)。
// 既定 off: GRAPHRAG_RAIL_READ=on (シェル env または .graphrag/.env) で opt-in。
// 常に非ブロッキング — vault 無し / off / CLI 失敗は全て無音で正常終了。
// 依存ゼロの素 node (spawn する CLI 側が strip-types を持つ)。

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { railEnabled } from "./prompt-rail.mjs";
import { findRepoRoot, isImplPath, resolveVaultDir, sanitizeSessionId, seenListIncludes } from "./touch-rail.mjs";

// ── rail-read 実行 (テスト DI: GRAPHRAG_READ_RAIL_CLI にスタブ .mjs を指せる) ──

const runRailRead = (root, relPath, sessionId) => {
  const stub = process.env.GRAPHRAG_READ_RAIL_CLI;
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const argv = stub
    ? [stub]
    : ["--experimental-strip-types", path.join(pluginRoot, "graphrag", "cli.ts"), "rail-read", "--file", relPath,
       ...(sessionId ? ["--session", sessionId] : [])];
  const out = execFileSync(process.execPath, argv, {
    encoding: "utf8",
    cwd: root,
    timeout: 12000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  });
  return JSON.parse(out);
};

const main = async () => {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  if (input?.tool_name !== "Read") return;
  const filePath = input?.tool_input?.file_path;
  if (!isImplPath(filePath)) return;

  const abs = path.resolve(filePath);
  const root = findRepoRoot(path.dirname(abs));
  if (!root) return;
  if (!railEnabled("GRAPHRAG_RAIL_READ", root)) return;
  const relPath = path.relative(root, abs).split(path.sep).join("/");
  if (relPath.startsWith("..")) return;

  const sessionId = sanitizeSessionId(input?.session_id);
  if (sessionId && seenListIncludes(resolveVaultDir(root), sessionId, "read_files", relPath)) return;

  const result = runRailRead(root, relPath, sessionId);
  if (result?.status !== "inject" || typeof result?.context !== "string") return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: result.context }
    }) + "\n"
  );
};

// テストから import できるよう、直接実行時のみ main を回す。
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await main();
  } catch {
    // 何があってもブロックしない — 無音で正常終了
  }
  process.exit(0);
}
