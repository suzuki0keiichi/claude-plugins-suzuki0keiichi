// Investigation / Goal ライフサイクルの棚卸し候補の機械抽出 (読み取り専用・意味判断なし)
//
// 目的: Investigation は「開くトリガは自然にあるが閉じるトリガが無い」ため、
// state 無しレガシーや決着済みなのに active のまま残った調査が黙って溜まる。
// Goal (state: planned/active) も同型 — 「あとで/別段階で」と予約された将来作業は、
// 定期的に浮上する装置が無ければ書かれなかったのと同じになる (VDU の Step2 残債:
// コミットメッセージの「別段階で」が2週間、誰の視野にも入らなかった)。
// 掃除を LLM の全読みにさせず、決定的な検出だけをここで行い suspect JSON を吐く。
// 「本当に閉じてよいか / まだやるのか」の裁定 (summary の自己申告よりコード/テスト/
// 実績の裏取りが勝つ) は人間起動の graphrag-stocktake skill に委ねる — 機械は候補提示のみ。
//
// 読み取り専用: loadGraph だけで動く。embedding / vector index 不要。vault への書き込み一切なし。
import { pathToFileURL } from "node:url";
import { loadGraph } from "./retrieval.ts";

// 進行中を自己申告するマーカー。title + summary のみに当てる —
// raw_content は作業メモで「途中」「未実装」等が正当に頻出し誤検知するので見ない。
const PROGRESS_MARKER_RE = /(進行中|未実装|未了|未対応|実装前|WIP|in progress)/gi;

export interface StocktakeSuspect {
  id: string;
  type: "Investigation" | "Goal";
  title: string;
  state: string | null;
  generated_at: string | null;
  signals: string[];
  progress_markers?: string[];
}

export interface StocktakeResult {
  generated_by: "graphrag/stocktake.ts";
  vault_dir: string;
  thresholds: { stale_days: number };
  counts: {
    investigations: number;
    active: number;
    stateless: number;
    goals_open: number;
    suspects: number;
  };
  suspects: StocktakeSuspect[];
  next_action_hint: string;
}

function cleanScalar(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// title + summary に当たった進行主張マーカーを出現順・重複なしで列挙する。
function collectProgressMarkers(node: Record<string, unknown>): string[] {
  const haystack = `${cleanScalar(node.title)}\n${cleanScalar(node.summary)}`;
  const markers: string[] = [];
  const seen = new Set<string>();
  for (const m of haystack.matchAll(PROGRESS_MARKER_RE)) {
    const word = m[0];
    if (seen.has(word)) continue;
    seen.add(word);
    markers.push(word);
  }
  return markers;
}

export function stocktake(
  graph: { nodes?: Record<string, unknown>[] },
  options: { vaultDir: string; staleDays: number; now?: number }
): StocktakeResult {
  const now = options.now ?? Date.now();
  const staleCutoff = now - options.staleDays * 24 * 60 * 60 * 1000;
  const suspects: StocktakeSuspect[] = [];

  // stale 判定 (共通): generated_at が閾値より古い。欠損/parse 不能は測れないが
  // 「放置の疑い」として stale 扱いにし、no-generated-at も併記する
  // (黙って見逃さない — 基準時刻が無いこと自体が可視化に値する)。
  const staleSignals = (generatedAt: string | null, staleSignal: string): string[] => {
    const t = generatedAt !== null ? Date.parse(generatedAt) : NaN;
    if (Number.isNaN(t)) return [staleSignal, "no-generated-at"];
    if (t < staleCutoff) return [staleSignal];
    return [];
  };

  // ── Investigation: active / stateless ──────────────────────────────────────
  const investigations = (graph.nodes ?? []).filter((n) => n.type === "Investigation");
  let activeCount = 0;
  let statelessCount = 0;
  for (const node of investigations) {
    const state = cleanScalar(node.state);
    const isActive = state === "active";
    const isStateless = state.length === 0;
    if (isActive) activeCount += 1;
    if (isStateless) statelessCount += 1;

    // closed 等の終端 state は意図的な決着 — suspect にしない。
    if (!isActive && !isStateless) continue;

    const signals: string[] = [];
    const generatedAtRaw = cleanScalar(node.generated_at);
    const generatedAt = generatedAtRaw.length > 0 ? generatedAtRaw : null;

    if (isStateless) signals.push("stateless");
    if (isActive) signals.push(...staleSignals(generatedAt, "stale-active"));

    const progressMarkers = collectProgressMarkers(node);
    if (progressMarkers.length > 0) signals.push("progress-claim");

    if (signals.length === 0) continue;
    suspects.push({
      id: String(node.id),
      type: "Investigation",
      title: typeof node.title === "string" ? node.title : String(node.id),
      state: isActive ? "active" : null,
      generated_at: generatedAt,
      signals,
      ...(progressMarkers.length > 0 ? { progress_markers: progressMarkers } : {})
    });
  }

  // ── Goal: planned / active の停滞 ──────────────────────────────────────────
  // state 無し Goal は対象外 (ライフサイクル分類の意図が無い)。terminal
  // (achieved / abandoned) も対象外。planned のまま古い = 予約された将来作業の
  // 発火装置。ここで浮上させ、裁定 (まだやる / abandoned / 実は済んで achieved)
  // は skill 側に委ねる。
  const goals = (graph.nodes ?? []).filter((n) => n.type === "Goal");
  let goalsOpen = 0;
  for (const node of goals) {
    const state = cleanScalar(node.state);
    if (state !== "planned" && state !== "active") continue;
    goalsOpen += 1;

    const generatedAtRaw = cleanScalar(node.generated_at);
    const generatedAt = generatedAtRaw.length > 0 ? generatedAtRaw : null;
    const signals = staleSignals(generatedAt, `stale-${state}-goal`);
    if (signals.length === 0) continue;
    suspects.push({
      id: String(node.id),
      type: "Goal",
      title: typeof node.title === "string" ? node.title : String(node.id),
      state,
      generated_at: generatedAt,
      signals
    });
  }

  // signals 数の多い順 → id 昇順で安定ソート。
  suspects.sort((a, b) => b.signals.length - a.signals.length || a.id.localeCompare(b.id));

  return {
    generated_by: "graphrag/stocktake.ts",
    vault_dir: options.vaultDir,
    thresholds: { stale_days: options.staleDays },
    counts: {
      investigations: investigations.length,
      active: activeCount,
      stateless: statelessCount,
      goals_open: goalsOpen,
      suspects: suspects.length
    },
    suspects,
    next_action_hint:
      suspects.length > 0
        ? "Adjudicate with the graphrag-stocktake skill (corroboration against code/tests/track record beats the summary's self-report. Investigations: never delete — only set closed. Goals: still wanted → keep; done → achieved; dead → abandoned)"
        : "Investigation/Goal lifecycle is healthy. No stocktake needed"
  };
}

function parseArgs(argv: string[]) {
  const p: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith("--")) { p[k] = v; i += 1; } else p[k] = true;
  }
  const days = Number(p.days);
  return {
    vault: typeof p.vault === "string" ? p.vault : process.env.GRAPHRAG_VAULT_DIR,
    staleDays: Number.isFinite(days) && days > 0 ? days : 14
  };
}

export async function runStocktake(
  argv: string[] = process.argv.slice(2)
): Promise<StocktakeResult> {
  const args = parseArgs(argv);
  if (!args.vault) {
    throw new Error("stocktake requires a vault: pass --vault <dir> or set GRAPHRAG_VAULT_DIR");
  }
  const graph = await loadGraph(args.vault);
  const result = stocktake(graph, { vaultDir: args.vault, staleDays: args.staleDays });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function isMainModule(url: string): boolean {
  if (!process.argv[1]) return false;
  const entryUrl = pathToFileURL(process.argv[1]).href;
  return entryUrl === url || entryUrl.replace(/\.mjs$/, ".ts") === url;
}
if (isMainModule(import.meta.url)) {
  await runStocktake();
}
