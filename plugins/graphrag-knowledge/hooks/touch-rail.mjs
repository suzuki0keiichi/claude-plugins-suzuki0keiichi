#!/usr/bin/env node
// ファイル接触時の読みレール (PreToolUse / Edit|Write)。
// これから編集するファイルに配線済みの知識 (constrains / documented_by / sets_policy_for /
// enforced_by / risks_in の逆引き) を、編集が着地する前に additionalContext で届ける。
// 状態: 2026-08-29 オーナー裁定で既定 off の停止裁定 (書き込み直前の advisory は正常性
// バイアスで手遅れ — investigation:graphrag-skill-dev:read-rails-dogfood 参照)。後継は
// 初回 Read 直後に同じ逆引きを届ける read-rail。opt-in (GRAPHRAG_RAIL_TOUCH=on) は残る。
// 実装の正本は rail-shared.mjs の runFileRailHook (touch/read 共通) — ここは spec だけ。
// 常に非ブロッキング — vault 無し / off / CLI 失敗は全て無音で正常終了 (編集は必ず通る)。

import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFileRailHook, seenListIncludes } from "./rail-shared.mjs";

// テスト互換の薄い皮 (fast-path 判定の直接ユニットテスト用)。
export const alreadyTouched = (vaultDir, sessionId, relPath) =>
  seenListIncludes(vaultDir, sessionId, "touch", relPath);

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await runFileRailHook({
      toolNames: ["Edit", "Write"],
      envName: "GRAPHRAG_RAIL_TOUCH",
      rail: "touch",
      cliVerb: "rail-touch",
      stubEnvVar: "GRAPHRAG_TOUCH_RAIL_CLI",
      buildOutput: (context) => ({ hookEventName: "PreToolUse", permissionDecision: "allow", additionalContext: context })
    });
  } catch {
    // 何があってもブロックしない — 無音で正常終了
  }
  process.exit(0);
}
