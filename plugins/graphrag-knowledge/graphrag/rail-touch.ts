/**
 * rail-touch: ファイル接触時の読みレール (PreToolUse Edit|Write hook の判定本体)。
 *
 * セッション後半のドリフト (失敗・複雑化の中で思いつきの編集が増え、グラフを引かなく
 * なる) への対抗。エージェント単独のツールループには新しいユーザープロンプトが無いため
 * rail-prompt は届かない — が、編集は必ず起きる。そこで「これから触るファイル」に
 * 配線済みの知識 (constrains / documented_by / sets_policy_for / enforced_by / risks_in
 * の逆引き = delta-check の connected_knowledge と同じ文法) を編集が着地する前に届ける。
 *
 * ノイズ設計:
 *   - 1ファイル1セッション1回 (touched_files)。注入済みノードは他レールと共有の
 *     seen-set で再注入しない (rail-prompt が出したものは出さない)。
 *   - 配線ゼロのファイルは沈黙 (このレールは検索ではなく登記の逆引き — 推測しない)。
 *   - Constraint 最優先 (delta-check と同じ型優先度) — 「破ったら落ちる」が先。
 *
 * 発火制御 (GRAPHRAG_RAIL_TOUCH) と impl 拡張子ゲート・既読 fast-path は hook 側
 * (hooks/touch-rail.mjs) の責務。verb 自体は明示起動なら常に判定を返す。
 */

import { pathToFileURL } from "node:url";
import { importVault } from "./import-vault.ts";
import { canonicalType } from "./schema.ts";
import { KNOWLEDGE_TO_FILE_EDGES } from "./crosscut-map.ts";
import {
  appendRailLog, composeRailContext, loadRailSeen, resolveRailCacheDir,
  sanitizeSessionId, saveRailSeen, RAIL_MAX_ITEMS, type RailItem
} from "./rail-common.ts";

/** delta-check の TYPE_PRIORITY と同じ並び (Constraint 最優先)。依存を薄く保つため写し。 */
const TYPE_PRIORITY: Record<string, number> = {
  Constraint: 0, Decision: 1, OperationalKnowledge: 2, Risk: 3, Goal: 4, Investigation: 5
};

/** グラフから1ファイルへの逆引き (純粋関数、テスト対象)。 */
export function reverseLookupFile(
  graph: { nodes?: any[]; edges?: any[] },
  relPath: string
): RailItem[] {
  const nodesById = new Map<string, any>();
  for (const n of graph.nodes ?? []) {
    if (typeof n?.id === "string") nodesById.set(n.id, n);
  }
  const byNode = new Map<string, { node: any; edges: Set<string> }>();
  for (const e of graph.edges ?? []) {
    if (typeof e?.type !== "string" || !KNOWLEDGE_TO_FILE_EDGES.has(e.type)) continue;
    if (typeof e.from !== "string" || typeof e.to !== "string") continue;
    const toNode = nodesById.get(e.to);
    const derived = e.to.startsWith("file:") ? e.to.split(":").slice(2).join(":") : null;
    const filePath =
      toNode && typeof toNode.path === "string" ? toNode.path : derived && derived.length > 0 ? derived : null;
    if (filePath !== relPath) continue;
    const fromNode = nodesById.get(e.from);
    if (!fromNode) continue;
    if (!byNode.has(e.from)) byNode.set(e.from, { node: fromNode, edges: new Set() });
    byNode.get(e.from)!.edges.add(e.type);
  }
  const items = [...byNode.values()].map(({ node, edges }) => {
    const type = canonicalType(String(node.type)) ?? String(node.type);
    return {
      item: {
        id: String(node.id),
        type,
        title: String(node.title ?? node.id),
        ...(typeof node.state === "string" && node.state.length > 0 ? { state: node.state } : {}),
        ...(typeof node.summary === "string" && node.summary.length > 0 ? { headline: node.summary } : {})
      } as RailItem,
      priority: TYPE_PRIORITY[type] ?? 9,
      degree: edges.size
    };
  });
  items.sort((a, b) => a.priority - b.priority || b.degree - a.degree || a.item.id.localeCompare(b.item.id));
  return items.map((x) => x.item);
}

interface RailTouchResult {
  status: "inject" | "silent";
  reason?: string;
  context?: string;
  ids?: string[];
  chars?: number;
}

export function railTouch(relPath: string, sessionId: string | null): RailTouchResult {
  const cacheDir = resolveRailCacheDir();
  const vaultDir = process.env.GRAPHRAG_VAULT_DIR;
  if (!vaultDir) return { status: "silent", reason: "no-vault" };

  const seen = cacheDir && sessionId ? loadRailSeen(cacheDir, sessionId) : null;
  if (seen?.touched_files.includes(relPath)) return { status: "silent", reason: "file-seen" };

  let graph: any;
  try {
    graph = importVault(vaultDir);
  } catch (e: any) {
    if (cacheDir) appendRailLog(cacheDir, { rail: "touch", fired: false, file: relPath, reason: `import-error: ${String(e?.message ?? e).slice(0, 120)}` });
    return { status: "silent", reason: "import-error" };
  }

  const seenIds = new Set(seen?.injected_node_ids ?? []);
  const all = reverseLookupFile(graph, relPath);
  const items = all.filter((i) => !seenIds.has(i.id)).slice(0, RAIL_MAX_ITEMS);
  const header =
    `Registered knowledge wired to ${relPath} (you are about to edit it — read before the edit; deepen via \`ask\`):`;
  const composed = composeRailContext("graphrag touch rail", header, items);

  // ヒットの有無に関わらずこのファイルは既読へ (配線ゼロのファイルに毎回 spawn しない)
  if (seen && cacheDir && sessionId) {
    seen.touched_files = [...new Set([...seen.touched_files, relPath])];
    if (composed) seen.injected_node_ids = [...new Set([...seen.injected_node_ids, ...composed.ids])];
    saveRailSeen(cacheDir, seen);
  }

  const logBase = { rail: "touch", file: relPath, wired: all.length, session: sessionId };
  if (!composed) {
    if (cacheDir) appendRailLog(cacheDir, { ...logBase, fired: false, reason: all.length === 0 ? "unwired" : "all-seen" });
    return { status: "silent", reason: all.length === 0 ? "unwired" : "all-seen" };
  }
  if (cacheDir) appendRailLog(cacheDir, { ...logBase, fired: true, ids: composed.ids, chars: composed.chars });
  return { status: "inject", context: composed.context, ids: composed.ids, chars: composed.chars };
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
