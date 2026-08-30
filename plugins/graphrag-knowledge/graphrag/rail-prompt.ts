/**
 * rail-prompt: 課題受領時の読みレール (UserPromptSubmit hook の判定本体)。
 *
 * 「着手前に ask で引く」を LLM の注意力 (skill description の確率的発火) から
 * 決定的機構へ移す — ハーネスの自走圧の下では「取りに行く記憶」は削られるため、
 * 記憶の側を行動経路 (プロンプト直後の additionalContext) に置く。
 *
 * ノイズ設計 (2026-07-31 の過去218プロンプト・リプレイ実測に基づく):
 *   - match_confidence === "high" のみ注入 (実プロンプトの ~30%、検分精度 ~73%)。
 *     low/none は沈黙 — リプレイ検分で low 帯はほぼ全て「沈黙が正解」だった。
 *   - 機械生成メッセージ (skill 前置文 / teammate-message / セッション継続通知) は
 *     prefix で除外 — リプレイで high の 15/81 を占めた注入無価値クラス。
 *   - セッション内 seen-set dedup — 同一議論の連続ターンで同一ノードに 3-6 連続
 *     ヒットすることが実測されており、実効注入数を決めるのは閾値よりこの dedup。
 *   - 迷ったら沈黙 (false negative 許容・false positive 予算ゼロ)。vault 不在・
 *     索引不在・検索失敗はすべて無音 (fail-open)。
 *
 * 発火制御 (GRAPHRAG_RAIL_PROMPT) は hook 側 (hooks/prompt-rail.mjs) の責務。
 * この verb 自体は明示起動なら常に判定を返す (手動テスト・リプレイ可能性のため)。
 */

import { pathToFileURL } from "node:url";
import { buildGraphBrief } from "./brief.ts";
import {
  appendRailLog, appendRailSeen, composeRailContext, loadRailSeen, resolveRailCacheDir,
  sanitizeSessionId, RAIL_MAX_ITEMS, type RailItem
} from "./rail-common.ts";

/** brief に渡すクエリの上限 (プロンプト全文は不要 — 冒頭に用件が来る)。 */
const QUERY_CLIP_CHARS = 400;
const MIN_PROMPT_CHARS = 15;
const SEARCH_LIMIT = 5;

/**
 * 機械生成メッセージ・信号ゼロプロンプトの除外。除外理由を返す (通過なら null)。
 * リプレイ実測で「high 判定なのに注入無価値」だったクラスを機械的に落とす。
 */
export function filterPromptText(text: string): string | null {
  const t = text.trim();
  if (t.length < MIN_PROMPT_CHARS) return "too-short";
  if (t.startsWith("/")) return "slash-command";
  if (t.startsWith("<") || t.startsWith("[")) return "markup";
  if (t.startsWith("Caveat:")) return "caveat";
  if (t.startsWith("Base directory for this skill")) return "skill-preamble";
  if (t.startsWith("Another Claude session sent")) return "teammate-message";
  if (t.startsWith("This session is being continued")) return "session-continuation";
  return null;
}

/** brief の match 配列から注入候補を選ぶ (seen 除外・cap)。純粋関数 (テスト対象)。 */
export function pickInjectable(
  matches: Array<{ node?: { id?: string; type?: string; title?: string; state?: string; summary?: string } }>,
  seenIds: ReadonlySet<string>
): RailItem[] {
  const items: RailItem[] = [];
  for (const m of matches) {
    const n = m?.node;
    if (!n || typeof n.id !== "string" || typeof n.title !== "string") continue;
    if (seenIds.has(n.id)) continue;
    items.push({
      id: n.id,
      type: String(n.type ?? "?"),
      title: n.title,
      ...(typeof n.state === "string" && n.state.length > 0 ? { state: n.state } : {}),
      ...(typeof n.summary === "string" && n.summary.length > 0 ? { headline: n.summary } : {})
    });
    if (items.length >= RAIL_MAX_ITEMS) break;
  }
  return items;
}

const HEADER =
  "Registered project knowledge related to this request (auto-surfaced; read before choosing an approach — deepen only if relevant via `ask`):";

async function readStdin(): Promise<string> {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

interface RailPromptResult {
  status: "inject" | "silent";
  reason?: string;
  context?: string;
  ids?: string[];
  chars?: number;
  confidence?: string;
}

export async function railPrompt(prompt: string, sessionId: string | null): Promise<RailPromptResult> {
  const filtered = filterPromptText(prompt);
  if (filtered) return { status: "silent", reason: filtered };

  const cacheDir = resolveRailCacheDir();

  let brief: any;
  try {
    brief = await buildGraphBrief({
      mode: "query",
      query: prompt.trim().replace(/\s+/g, " ").slice(0, QUERY_CLIP_CHARS),
      limit: SEARCH_LIMIT
    });
  } catch (e: any) {
    if (cacheDir) appendRailLog(cacheDir, { rail: "prompt", fired: false, reason: `brief-error: ${String(e?.message ?? e).slice(0, 120)}` });
    return { status: "silent", reason: "brief-error" };
  }

  const confidence = brief?.query?.match_confidence ?? "none";
  const topVec = (() => {
    const reasons: string[] = brief?.query?.matches?.[0]?.reasons ?? [];
    const v = reasons.find((r) => r.startsWith("vector:"));
    return v ? Number(v.slice("vector:".length)) : null;
  })();
  const logBase = { rail: "prompt", confidence, top_vec: topVec, session: sessionId };

  if (confidence !== "high") {
    if (cacheDir) appendRailLog(cacheDir, { ...logBase, fired: false, reason: "low-confidence" });
    return { status: "silent", reason: "low-confidence", confidence };
  }

  const seen = cacheDir && sessionId ? loadRailSeen(cacheDir, sessionId) : null;
  const seenIds = new Set(seen?.injected_node_ids ?? []);
  const items = pickInjectable(brief?.query?.matches ?? [], seenIds);
  const composed = composeRailContext("graphrag prompt rail", HEADER, items);
  if (!composed) {
    if (cacheDir) appendRailLog(cacheDir, { ...logBase, fired: false, reason: items.length === 0 ? "all-seen" : "over-budget" });
    return { status: "silent", reason: "all-seen", confidence };
  }

  if (seen && cacheDir && sessionId) {
    const ok = appendRailSeen(cacheDir, sessionId, { nodeIds: composed.ids });
    if (!ok) appendRailLog(cacheDir, { rail: "prompt", reason: "seen-save-error", session: sessionId });
  }
  if (cacheDir) appendRailLog(cacheDir, { ...logBase, fired: true, ids: composed.ids, chars: composed.chars });
  return { status: "inject", context: composed.context, ids: composed.ids, chars: composed.chars, confidence };
}

export async function runRailPrompt(argv: string[] = process.argv.slice(2)) {
  let prompt = "";
  let sessionId: string | null = null;
  let useStdin = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--prompt") prompt = argv[++i] ?? "";
    else if (argv[i] === "--session") sessionId = sanitizeSessionId(argv[++i]);
    else if (argv[i] === "--stdin") useStdin = true;
  }
  if (useStdin) prompt = await readStdin();
  const result = await railPrompt(prompt, sessionId);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runRailPrompt();
}
