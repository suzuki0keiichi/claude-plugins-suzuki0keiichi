#!/usr/bin/env node
// read レールの精度測定の相棒 (PostToolUse / Edit|Write)。
// GRAPHRAG_RAIL_READ=on の間だけ、実装ファイルへの編集イベントを rail-log.jsonl に
// 1行追記する ({rail:"edit-observe", file, session})。これで「read レールが注入した
// ファイルがその後同セッションで編集されたか」(的中率) を rail-log だけで集計できる。
// 注入は一切しない・spawn もしない (直接 append のみ)。dogfood 測定レーンであり、
// レール本体が卒業裁定を受けたら外してよい。
// 常に非ブロッキング — 失敗は全て無音で正常終了。依存ゼロの素 node。

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { railEnabled } from "./prompt-rail.mjs";
import { findRepoRoot, isImplPath, resolveVaultDir, sanitizeSessionId } from "./touch-rail.mjs";

export const cacheDirFor = (vaultDir) => {
  let stateDir = path.dirname(path.resolve(vaultDir));
  if (path.basename(stateDir) !== ".graphrag") stateDir = path.join(stateDir, ".graphrag");
  return path.join(stateDir, "cache");
};

const main = async () => {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  if (input?.tool_name !== "Edit" && input?.tool_name !== "Write") return;
  const filePath = input?.tool_input?.file_path;
  if (!isImplPath(filePath)) return;

  const abs = path.resolve(filePath);
  const root = findRepoRoot(path.dirname(abs));
  if (!root) return;
  if (!railEnabled("GRAPHRAG_RAIL_READ", root)) return;
  const relPath = path.relative(root, abs).split(path.sep).join("/");
  if (relPath.startsWith("..")) return;

  const cacheDir = cacheDirFor(resolveVaultDir(root));
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const entry = {
    ts: new Date().toISOString(),
    rail: "edit-observe",
    file: relPath,
    session: sanitizeSessionId(input?.session_id)
  };
  // ローテーションは CLI 側の書き込み (lane-log) に任せる — ここは1行 append のみ
  appendFileSync(path.join(cacheDir, "rail-log.jsonl"), JSON.stringify(entry) + "\n");
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
