#!/usr/bin/env node
// ファイル読み取り時の読みレール (PostToolUse / Read)。
// いま読んだファイルに配線済みの知識 (touch レールと同じ逆引き文法) を、方針がコンテキストに
// 堆積する前 (= 初回 Read の直後) に additionalContext で届ける。touch レール (書き込み直前
// advisory) は正常性バイアスで手遅れと裁定され既定 off — 同じ逆引きを届ける時刻だけ前に
// 移した後継。既定 off: GRAPHRAG_RAIL_READ=on (シェル env または .graphrag/.env) で opt-in。
// 実装の正本は rail-shared.mjs の runFileRailHook (touch/read 共通) — ここは spec だけ。
// 判定・dedup・ログの正本は CLI 側 (graphrag/rail-read.ts railFileLane)。
// 常に非ブロッキング — vault 無し / off / CLI 失敗は全て無音で正常終了。

import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFileRailHook } from "./rail-shared.mjs";

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await runFileRailHook({
      toolNames: ["Read"],
      envName: "GRAPHRAG_RAIL_READ",
      rail: "read",
      cliVerb: "rail-read",
      stubEnvVar: "GRAPHRAG_READ_RAIL_CLI",
      buildOutput: (context) => ({ hookEventName: "PostToolUse", additionalContext: context })
    });
  } catch {
    // 何があってもブロックしない — 無音で正常終了
  }
  process.exit(0);
}
