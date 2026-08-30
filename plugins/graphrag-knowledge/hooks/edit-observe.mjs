#!/usr/bin/env node
// read レールの精度測定の相棒 (PostToolUse / Edit|Write)。
// GRAPHRAG_RAIL_READ=on の間だけ、実装ファイルへの編集イベントを rail-log.jsonl に
// 1行追記する ({rail:"edit-observe", file, session})。これで「read レールが注入した
// ファイルがその後同セッションで編集されたか」(的中率) を rail-log だけで集計できる。
// 注入は一切しない・spawn もしない (直接 append のみ・ローテーションガード込み)。
// この hook 自身の目的が記録なので、append 失敗だけは stderr に一言残す (hook debug で
// 見える) — 「計測器が壊れたまま precision が静かに過小評価される」を防ぐ。
// dogfood 測定レーンであり、レール本体が卒業裁定を受けたら外してよい。
// 常に非ブロッキング。依存ゼロの素 node。

import path from "node:path";
import { fileURLToPath } from "node:url";
import { railEnabled } from "./prompt-rail.mjs";
import {
  appendRailLogDirect, cacheDirForVaultDir, findRepoRoot, isExcludedRelPath, isImplPath,
  resolveVaultDir, sanitizeSessionId
} from "./rail-shared.mjs";

const main = async () => {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  if (input?.tool_name !== "Edit" && input?.tool_name !== "Write") return;
  // 失敗した編集は的中率の分子に入れない (PostToolUse は通常成功時のみだが防御的に)
  if (input?.tool_response?.success === false) return;
  const filePath = input?.tool_input?.file_path;
  if (!isImplPath(filePath)) return;

  const abs = path.resolve(filePath);
  const root = findRepoRoot(path.dirname(abs));
  if (!root) return;
  if (!railEnabled("GRAPHRAG_RAIL_READ", root)) return;
  const relPath = path.relative(root, abs).split(path.sep).join("/");
  if (relPath.startsWith("..") || isExcludedRelPath(relPath)) return;

  const cacheDir = cacheDirForVaultDir(resolveVaultDir(root));
  const ok = appendRailLogDirect(cacheDir, {
    rail: "edit-observe",
    file: relPath,
    session: sanitizeSessionId(input?.session_id)
  });
  if (!ok) process.stderr.write(`graphrag edit-observe: rail-log append failed (${cacheDir})\n`);
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
