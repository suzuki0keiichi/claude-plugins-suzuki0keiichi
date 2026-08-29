/**
 * rail-read: ファイル読み取り時の読みレール (PostToolUse Read hook の判定本体)。
 *
 * touch レール (書き込み直前 advisory) の後継。書き込み時点では方針がコンテキストに
 * 堆積し正常性バイアスで advisory が素通りされる (2026-08-29 オーナー裁定で touch 停止) —
 * 訂正が成立するのは堆積の前だけ。ファイルを初めて Read する瞬間はまだ方針が固まる前の
 * 最後の窓なので、そこへ配線済み知識 (rail-touch と同じ逆引き文法) を届ける。
 *
 * ノイズ設計 (2026-08-30 事前シミュレーション実測に基づく):
 *   - 1ファイル1セッション1回 (read_files)。注入済みノードは他レール共有の seen-set で
 *     再注入しない。セッション総量の上限は置かない — 実測でレール税はツール出力総量の
 *     0.2% (マラソンセッションで 27KB/13MB) であり、少数の固定予算はマラソンでは冒頭で
 *     尽きてレールを殺すだけ。主抑制は per-file-once + node-dedup。
 *   - 配線ゼロのファイルは沈黙 (登記の逆引きであり検索ではない — 推測しない)。
 *   - Constraint 最優先 (TYPE_PRIORITY は rail-touch と共有)。
 *
 * 発火制御 (GRAPHRAG_RAIL_READ) と impl 拡張子ゲート・既読 fast-path は hook 側
 * (hooks/read-rail.mjs) の責務。verb 自体は明示起動なら常に判定を返す。
 */

import { pathToFileURL } from "node:url";
import { importVault } from "./import-vault.ts";
import { reverseLookupFile } from "./rail-touch.ts";
import {
  appendRailLog, composeRailContext, loadRailSeen, resolveRailCacheDir,
  sanitizeSessionId, saveRailSeen, RAIL_MAX_ITEMS
} from "./rail-common.ts";

interface RailReadResult {
  status: "inject" | "silent";
  reason?: string;
  context?: string;
  ids?: string[];
  chars?: number;
}

export function railRead(relPath: string, sessionId: string | null): RailReadResult {
  const cacheDir = resolveRailCacheDir();
  const vaultDir = process.env.GRAPHRAG_VAULT_DIR;
  if (!vaultDir) return { status: "silent", reason: "no-vault" };

  const seen = cacheDir && sessionId ? loadRailSeen(cacheDir, sessionId) : null;
  if (seen?.read_files.includes(relPath)) return { status: "silent", reason: "file-seen" };

  let graph: any;
  try {
    graph = importVault(vaultDir);
  } catch (e: any) {
    if (cacheDir) appendRailLog(cacheDir, { rail: "read", fired: false, file: relPath, reason: `import-error: ${String(e?.message ?? e).slice(0, 120)}` });
    return { status: "silent", reason: "import-error" };
  }

  const seenIds = new Set(seen?.injected_node_ids ?? []);
  const all = reverseLookupFile(graph, relPath);
  const items = all.filter((i) => !seenIds.has(i.id)).slice(0, RAIL_MAX_ITEMS);
  const header =
    `Registered knowledge wired to ${relPath} (you just read it — factor this in before forming a plan; deepen via \`ask\`):`;
  const composed = composeRailContext("graphrag read rail", header, items);

  // ヒットの有無に関わらずこのファイルは既読へ (配線ゼロのファイルに毎回 spawn しない)
  if (seen && cacheDir && sessionId) {
    seen.read_files = [...new Set([...seen.read_files, relPath])];
    if (composed) seen.injected_node_ids = [...new Set([...seen.injected_node_ids, ...composed.ids])];
    saveRailSeen(cacheDir, seen);
  }

  const logBase = { rail: "read", file: relPath, wired: all.length, session: sessionId };
  if (!composed) {
    if (cacheDir) appendRailLog(cacheDir, { ...logBase, fired: false, reason: all.length === 0 ? "unwired" : "all-seen" });
    return { status: "silent", reason: all.length === 0 ? "unwired" : "all-seen" };
  }
  if (cacheDir) appendRailLog(cacheDir, { ...logBase, fired: true, ids: composed.ids, chars: composed.chars });
  return { status: "inject", context: composed.context, ids: composed.ids, chars: composed.chars };
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
