/**
 * rail-touch: ファイル接触時の読みレール (PreToolUse Edit|Write hook の判定本体)。
 *
 * 「これから触るファイル」に配線済みの知識 (constrains / documented_by /
 * sets_policy_for / enforced_by / risks_in の逆引き) を編集が着地する前に届ける。
 *
 * 状態 (2026-08-29 オーナー裁定): 書き込み直前の advisory は、方針がコンテキストに
 * 堆積した後では正常性バイアスで素通りされ手遅れ — dogfood で停止裁定
 * (investigation:graphrag-skill-dev:read-rails-dogfood)。同じ逆引きを初回 Read 直後
 * (堆積前) に移した rail-read が後継。verb と hook は opt-in (GRAPHRAG_RAIL_TOUCH=on)
 * のまま残る — 停止は既定 off の裁定であって登録解除ではない。
 *
 * 実装の正本は rail-common の railFileLane (touch/read 共通) — ここは列挙キーと
 * 文面だけを渡す薄い皮。発火制御と拡張子ゲート・fast-path は hook 側
 * (hooks/touch-rail.mjs) の責務。verb 自体は明示起動なら常に判定を返す。
 */

import { pathToFileURL } from "node:url";
import { railFileLane, sanitizeSessionId, type RailFileLaneResult } from "./rail-common.ts";

// 旧来の import 面の互換 (テスト・外部利用): 逆引きの正本は rail-common へ移動済み。
export { reverseLookupFile } from "./rail-common.ts";

export function railTouch(relPath: string, sessionId: string | null): RailFileLaneResult {
  return railFileLane(
    {
      rail: "touch",
      listKey: "touched_files",
      tag: "graphrag touch rail",
      header: (p) =>
        `Registered knowledge wired to ${p} (you are about to edit it — read before the edit; deepen via \`ask\`):`
    },
    relPath,
    sessionId
  );
}

export function runRailTouch(argv: string[] = process.argv.slice(2)) {
  let file = "";
  let sessionId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") file = argv[++i] ?? "";
    else if (argv[i] === "--session") sessionId = sanitizeSessionId(argv[++i]);
  }
  if (!file) {
    process.stderr.write("usage: rail-touch --file <repo-relative-path> [--session <id>]\n");
    process.exit(2);
  }
  const result = railTouch(file.split("\\").join("/"), sessionId);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runRailTouch();
}
