/**
 * rail-read: ファイル読み取り時の読みレール (PostToolUse Read hook の判定本体)。
 *
 * touch レール (書き込み直前 advisory) の後継。書き込み時点では方針がコンテキストに
 * 堆積し正常性バイアスで advisory が素通りされる (2026-08-29 オーナー裁定で touch は
 * 既定 off の停止裁定) — 訂正が成立するのは堆積の前だけ。ファイルを初めて Read する
 * 瞬間はまだ方針が固まる前の最後の窓なので、そこへ配線済み知識を届ける。
 *
 * ノイズ設計 (2026-08-30 事前シミュレーション実測に基づく):
 *   - 1ファイル1セッション1回 (read_files; session id が無い時は hook 側が沈黙し、
 *     verb 明示起動のみ dedup なしで通る)。注入済みノードは他レール共有の seen-set で
 *     再注入しない。セッション総量の上限は置かない — 実測でレール税はツール出力総量の
 *     0.2% (マラソンセッションで 27KB/13MB) であり、少数の固定予算はマラソンでは冒頭で
 *     尽きてレールを殺すだけ。主抑制は per-file-once + node-dedup。
 *   - 配線ゼロのファイルは沈黙 (登記の逆引きであり検索ではない — 推測しない)。
 *   - Constraint 最優先 (TYPE_PRIORITY は rail-common の逆引きに集約)。
 *
 * 実装の正本は rail-common の railFileLane (touch/read 共通)。seen 判定の正本も
 * そこ — hook 側 (hooks/read-rail.mjs) の fast-path は spawn 節約であって正しさの
 * 根拠ではない。発火制御 (GRAPHRAG_RAIL_READ) と impl 拡張子ゲートは hook 側の責務。
 */

import { pathToFileURL } from "node:url";
import { railFileLane, sanitizeSessionId, type RailFileLaneResult } from "./rail-common.ts";

export function railRead(relPath: string, sessionId: string | null): RailFileLaneResult {
  return railFileLane(
    {
      rail: "read",
      listKey: "read_files",
      tag: "graphrag read rail",
      header: (p) =>
        `Registered knowledge wired to ${p} (you just read it — factor this in before forming a plan; deepen via \`ask\`):`
    },
    relPath,
    sessionId
  );
}

export function runRailRead(argv: string[] = process.argv.slice(2)) {
  let file = "";
  let sessionId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") file = argv[++i] ?? "";
    else if (argv[i] === "--session") sessionId = sanitizeSessionId(argv[++i]);
  }
  if (!file) {
    process.stderr.write("usage: rail-read --file <repo-relative-path> [--session <id>]\n");
    process.exit(2);
  }
  const result = railRead(file.split("\\").join("/"), sessionId);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runRailRead();
}
