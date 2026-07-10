import { pathToFileURL } from "node:url";
import { confidenceMessage, gradeConfidence, judgeMatchConfidence } from "./confidence.ts";
import { edgePriority, loadGraph, loadRequiredVectorIndex, prepareVectorSearch, searchGraph } from "./retrieval.ts";
import { validateGraph } from "./schema.ts";
import { describeVectorIndex } from "./vector.ts";

// Score thresholds + judgeMatchConfidence/confidenceMessage now live in
// ./confidence.ts so brief and evidence-packet share one tuned copy. Re-export
// judgeMatchConfidence to keep brief.ts's existing import surface stable.
export { judgeMatchConfidence };

const DEFAULT_SUMMARY_CHARS = 280;
const DEFAULT_LIMIT = 5;
// resume が primary の作業状態 (Investigation.raw_content) を surface する際の上限。
// summary より長く許すが、compact 直後の注入文脈を膨らませすぎない中庸。
const RESUME_RAW_CHARS = 2000;
// resume が active Investigation にぶら下げて surface する「恒久知識」型。
// checkpoint はこの focus が生んだ知識を derived_from / led_to で Investigation に繋ぐので、
// 文章 (work_state) だけでなく実ノードへ到達させる。計画/構造型 (Task/Milestone/File/Layer 等) は
// 意図的に除外 — checkpoint の守備範囲外 (チャット作業がプロジェクト計画を書き換えない)。
const RESUME_LINKED_TYPES = new Set([
  "Decision", "RejectedOption", "Risk", "OperationalKnowledge",
  "Goal", "Assumption", "Agreement"
]);

const CALL_EXCESSIVE = 3;

type RepeatState = "fresh" | "followup" | "excessive";

export async function buildGraphBrief(options: any = {}) {
  const graphSource = options.graph ?? process.env.GRAPHRAG_VAULT_DIR;
  const graph = options.graphData ?? await loadGraph(graphSource);
  const nodesById = new Map((graph.nodes ?? []).map((node) => [node.id, node]));
  const mode = options.mode ?? (options.query ? "query" : "resume");
  const summaryChars = options.summaryChars ?? DEFAULT_SUMMARY_CHARS;

  const base = {
    generated_by: "graphrag/brief.ts",
    mode,
    graph: graphHealth(graph, graphSource)
  };

  if (mode === "resume") {
    return {
      ...base,
      active: buildResumeBrief(graph, nodesById, {
        limit: options.limit ?? 1,
        summaryChars,
        includeCandidates: options.includeCandidates ?? false
      }),
      usage: [
        "Use active.primary.work_state (the checkpointed focus / next actions / blockers / in-flight edits) and active.primary.linked_knowledge before running broad evidence retrieval.",
        "Follow active.primary.scratch (discussed_in ConversationChunk) only when work_state is not enough — it holds the deep raw log.",
        "Run graph:evidence only after choosing a concrete next action that needs source-backed context."
      ]
    };
  }

  if (mode === "query") {
    if (!options.query) throw new Error("Missing --query <text> for --mode query");
    return {
      ...base,
      query: await buildQueryBrief(graph, nodesById, {
        query: options.query,
        vaultDir: graphSource,
        vectorPath: options.vector,
        vectorIndex: options.vectorIndex,
        queryVector: options.queryVector,
        // R6 multi-query (--gist): 複数クエリベクトル。R5 graph rerank の on/off。
        // どちらも未指定なら従来挙動 (single vector / rerank on)。
        queryVectors: options.queryVectors,
        graphRerank: options.graphRerank,
        limit: options.limit ?? DEFAULT_LIMIT,
        summaryChars,
        relationLimit: options.relationLimit ?? 8,
        callNumber: options.callNumber
      }),
      usage: [
        "Use matches to choose the smallest relevant node set.",
        "If query.match_confidence is 'low' or 'none', try one alternative keyword; if still no hit, switch to code/doc direct reading instead of repeating graph queries.",
        "If query.repeat.repeat_state is 'excessive', stop graph search and switch to graph-external sources.",
        "Escalate to graph:evidence only when the brief does not contain enough provenance."
      ]
    };
  }

  throw new Error(`Unknown brief mode: ${mode}`);
}

export function buildResumeBrief(graph, nodesById, options: any = {}) {
  const investigations = (graph.nodes ?? []).filter((node) => node.type === "Investigation");
  const active = investigations
    .filter((node) => node.state === "active")
    .map((node) => ({
      ...compactNode(node, options),
      // 並べ替えキー。checkpoint は op:update で generated_at を now に進めるので、
      // これで「最新の checkpoint を刻んだ Investigation」が primary になる。
      generated_at: cleanScalar(node.generated_at) || null,
      // A (退避): 作業状態 (focus / 次アクション / 詰まり / 途中の編集) は
      // Investigation.raw_content に構造化テキストで載る。compact 直後の再水和の本体。
      work_state: truncate(node.raw_content, RESUME_RAW_CHARS),
      // B への到達: この focus が生んだ恒久知識。checkpoint が derived_from (知識→Investigation)
      // と led_to (Investigation→Decision) で張る。文章だけでなく実ノードに届かせる。
      linked_knowledge: linkedNodes(graph, nodesById, node.id, {
        types: RESUME_LINKED_TYPES,
        relations: new Set(["led_to", "has_premise", "derived_from"]),
        minimal: true,
        limit: 8
      }),
      // 深い生ログ (会話 / 正確なコマンド / 非自明な発見) は discussed_in で繋がる
      // ConversationChunk 側。ポインタだけ surface し、本文は必要時に辿らせる。
      scratch: linkedNodes(graph, nodesById, node.id, {
        types: new Set(["ConversationChunk"]),
        relations: new Set(["discussed_in"]),
        minimal: true,
        limit: 3
      })
    }))
    .sort(compareResumeItems);

  const primary = active[0] ?? null;

  // 大声原則: active が 0 件でも state 無し Investigation が居れば黙って空を返さない。
  // (state 導入前の旧データは全件 state 無しで、resume が構造的に空振りしていた)
  const stateless = investigations.filter((node) => node.state === undefined || node.state === null);
  const legacyNotice = active.length === 0 && stateless.length > 0
    ? {
        legacy_stateless_investigations: stateless.length,
        legacy_note:
          `0 active Investigations, but ${stateless.length} stateless Investigation(s) exist. ` +
          "Stateless is legacy data with no live/settled distinction. Set state:\"active\" on live ones, state:\"closed\" on finished ones."
      }
    : {};

  // 棚卸し誘導: state 無しレガシーが居る、または active が溜まり気味 (3 件以上) のとき、
  // 決定的な検出 verb (stocktake) の存在を思い出させる。閾値未満なら埋め草を出さない
  // (null 埋め禁止 — 既存の legacy_note と同じく「出す時だけ出す」流儀)。
  const stocktakeNotice = stateless.length > 0 || active.length >= 3
    ? {
        stocktake_hint:
          `${stateless.length} stateless Investigation(s) / ${active.length} active. ` +
          "Run $CLI stocktake to review stocktake candidates"
      }
    : {};

  return {
    primary,
    candidates: options.includeCandidates ? active.slice(0, options.limit ?? 3) : undefined,
    active_count: active.length,
    ...legacyNotice,
    ...stocktakeNotice
  };
}

export async function buildQueryBrief(graph, nodesById, options: any = {}) {
  // 呼び出し側 (ask の world ヒント等) が索引とクエリ embedding を済ませている時は
  // 共用する (同じ問いを 2 回 embedding しない)。無ければ従来どおりここで行う。
  const vectorIndex = options.vectorIndex
    ?? await loadRequiredVectorIndex(options.vaultDir, options.vectorPath);
  // R6: queryVectors (複数) が来ていれば最優先 (gist + 質問の両埋め込み)。
  // 次に従来の単一 queryVector、無ければここで embed する。
  let vectorSearch: any;
  if (Array.isArray(options.queryVectors) && options.queryVectors.length > 0) {
    vectorSearch = { vectorIndex, queryVectors: options.queryVectors };
  } else if (options.queryVector !== undefined && options.queryVector !== null) {
    vectorSearch = { vectorIndex, queryVector: options.queryVector };
  } else {
    vectorSearch = await prepareVectorSearch(options.query, { vectorIndex });
  }
  const matches = searchGraph(graph, options.query, {
    limit: options.limit,
    // R5 graph rerank: 既定 off (実 vault で hub 偏重の net-negative を実測。
    // retrieval.ts の R5 コメント参照)。--graph-rerank on で opt-in。
    ...(options.graphRerank !== undefined ? { graphRerank: options.graphRerank } : {}),
    ...vectorSearch
  });
  // relations のノード詳細は brief 全体で 1 回だけ出す (2 回目以降は id 参照)。
  // match ノード自体は matches[].node に全文が出るので最初から「出現済み」扱い。
  const seenRelationNodeIds = new Set<string>(matches.map((match) => match.node.id));
  const compactMatches = matches.map((match, index) => ({
    rank: index + 1,
    score: match.score,
    reasons: compactReasons(match.reasons),
    // 終端 state による減点注記 (searchGraph 付与) はそのまま透過する
    ...(match.state_note ? { state_note: match.state_note } : {}),
    node: compactNode(match.node, options),
    relations: compactRelations(graph, nodesById, match.node.id, {
      limit: options.relationLimit,
      summaryChars: options.summaryChars,
      seenNodeIds: seenRelationNodeIds
    })
  }));
  // R4 standout: 上位 2 件の相対 gap で「この問いの領域に固有」なら 1 段格上げ。
  // vector は索引メタの noise_baseline (在れば) でコーパス相対に判定する。
  const graded = gradeConfidence(compactMatches, {
    noiseBaseline: vectorIndex?.noise_baseline ?? null
  });

  return {
    text: options.query,
    vector: describeVectorIndex(vectorIndex),
    match_confidence: graded.confidence,
    confidence_message: confidenceMessage(graded.confidence),
    standout: graded.standout,
    repeat: buildRepeatGuidance(options.callNumber),
    matches: compactMatches
  };
}

export function buildRepeatGuidance(callNumber: number | undefined): { repeat_state: RepeatState; message: string | null } {
  const n = Number(callNumber);
  if (!Number.isFinite(n) || n <= 1) {
    return { repeat_state: "fresh", message: null };
  }
  if (n < CALL_EXCESSIVE) {
    return { repeat_state: "followup", message: null };
  }
  return {
    repeat_state: "excessive",
    message: `Same-focus query call #${n}. Graph likely does not cover this area. Stop repeating graph queries and switch to graph-external sources (code/doc direct reading).`
  };
}

export function graphHealth(graph, graphSource) {
  const failures = validateGraph(graph);
  return {
    source: graphSource,
    loaded_from: graph.source ?? null,
    nodes: graph.nodes?.length ?? 0,
    edges: graph.edges?.length ?? 0,
    failures_count: failures.length,
    failures_sample: failures.slice(0, 5)
  };
}

// null/欠損フィールドは出力しない (旧実装は path: null / state: null を全ノードに
// 撒いていた — LLM 向け出力では純粋な無駄)。
function compactNode(node, options: any = {}) {
  const summary = truncate(node.summary, options.summaryChars ?? DEFAULT_SUMMARY_CHARS);
  return {
    id: node.id,
    type: node.type,
    ...(node.title != null ? { title: node.title } : {}),
    ...(summary != null ? { summary } : {}),
    ...(node.path != null ? { path: node.path } : {}),
    ...(node.state != null ? { state: node.state } : {})
  };
}

function linkedNodes(graph, nodesById, nodeId, options: any = {}) {
  const relations = options.relations ?? new Set();
  const linked = [];
  for (const edge of graph.edges ?? []) {
    if (relations.size > 0 && !relations.has(edge.type)) continue;
    if (edge.from !== nodeId && edge.to !== nodeId) continue;
    const otherId = edge.from === nodeId ? edge.to : edge.from;
    const other = nodesById.get(otherId);
    if (!other) continue;
    if (options.type && other.type !== options.type) continue;
    if (options.types && !options.types.has(other.type)) continue;
    linked.push({
      relation: edge.type,
      direction: edge.from === nodeId ? "out" : "in",
      node: options.minimal ? minimalNode(other) : compactNode(other, options)
    });
  }
  return linked.slice(0, options.limit ?? 5);
}

function minimalNode(node) {
  return {
    id: node.id,
    type: node.type,
    title: node.title ?? null,
    state: node.state ?? null
  };
}

// relations のノード要約は文脈確認用なので match 本体より短く切る。
const RELATION_SUMMARY_CHARS = 120;

function compactRelations(graph, nodesById, nodeId, options: any = {}) {
  const incident = [];
  for (const edge of graph.edges ?? []) {
    if (edge.from !== nodeId && edge.to !== nodeId) continue;
    const otherId = edge.from === nodeId ? edge.to : edge.from;
    const direction = edge.from === nodeId ? "out" : "in";
    const other = nodesById.get(otherId);
    if (!other) {
      // 未解決の cross-vault 参照 (vault:<slug>/<nodeId>) はローカルに実体が無い。
      // 黙って落とすと ask の cross_vault_resolved 拡張 (xref-resolver) が一生
      // 発火しないので、参照文字列を to に載せた stub として出す。
      if (typeof otherId === "string" && otherId.startsWith("vault:")) {
        incident.push({ edge, stub: { relation: edge.type, direction, to: otherId } });
      }
      continue;
    }
    incident.push({ edge, direction, other });
  }
  // cap で切る前に edge 型優先度で並べる (expandNeighbors と同じ優先度)。
  // superseded な match の後継 (supersedes/refines) が cap から溢れて
  // state_note の「refines 逆引きで後継を確認」が空振りするのを防ぐ。
  incident.sort((a, b) => edgePriority(a.edge.type) - edgePriority(b.edge.type));

  const seen: Set<string> = options.seenNodeIds ?? new Set();
  const relations = [];
  for (const item of incident.slice(0, options.limit ?? 8)) {
    if (item.stub) {
      relations.push(item.stub);
      continue;
    }
    const { edge, direction, other } = item;
    if (seen.has(other.id)) {
      // 2 回目以降の出現は id 参照のみ (詳細は初出箇所 / matches[].node を見る)。
      relations.push({ relation: edge.type, direction, id: other.id });
      continue;
    }
    seen.add(other.id);
    relations.push({
      relation: edge.type,
      direction,
      node: compactNode(other, {
        ...options,
        summaryChars: Math.min(options.summaryChars ?? DEFAULT_SUMMARY_CHARS, RELATION_SUMMARY_CHARS)
      })
    });
  }
  return relations;
}

function compactReasons(reasons = []) {
  return reasons.filter((reason) =>
    reason.startsWith("alias") || reason.startsWith("vector:") || reason.startsWith("ngram:") ||
    reason.startsWith("coverage:") || reason.startsWith("state:")
  );
}

function compareResumeItems(left, right) {
  // generated_at 降順 (= 最終更新が新しい順)。checkpoint は op:update で generated_at を
  // 進めるので最新 checkpoint が先頭 (primary) に来る。旧キー updated_at はどこにも
  // 書かれず常に null だったため id 順に空振りしていた — 実在する generated_at に統一。
  const leftTime = Date.parse(left.generated_at ?? "");
  const rightTime = Date.parse(right.generated_at ?? "");
  const leftSortable = Number.isNaN(leftTime) ? 0 : leftTime;
  const rightSortable = Number.isNaN(rightTime) ? 0 : rightTime;
  return rightSortable - leftSortable || left.id.localeCompare(right.id);
}

function parseListLike(value) {
  if (Array.isArray(value)) return value.map(cleanScalar).filter(Boolean);
  const text = cleanScalar(value);
  if (!text) return [];
  const bracketed = text.match(/^\[(.*)\]$/s)?.[1] ?? text;
  return bracketed
    .split(/\s*,\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanScalar(value) {
  return typeof value === "string" ? value.trim() : "";
}

function truncate(value, maxChars) {
  if (typeof value !== "string") return null;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function parseArgs(argv) {
  const parsed: any = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) {
      parsed[key] = value;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }

  return {
    mode: typeof parsed.mode === "string" ? parsed.mode : undefined,
    query: typeof parsed.query === "string" ? parsed.query : undefined,
    graph: typeof parsed.graph === "string" ? parsed.graph : undefined,
    graphName: typeof parsed.graphName === "string" ? parsed.graphName : undefined,
    host: typeof parsed.host === "string" ? parsed.host : undefined,
    port: typeof parsed.port === "string" && Number.isFinite(Number(parsed.port)) ? Number(parsed.port) : undefined,
    password: typeof parsed.password === "string" ? parsed.password : undefined,
    vector: typeof parsed.vector === "string" ? parsed.vector : undefined,
    limit: typeof parsed.limit === "string" ? Number(parsed.limit) : undefined,
    relationLimit: typeof parsed["relation-limit"] === "string" ? Number(parsed["relation-limit"]) : undefined,
    summaryChars: typeof parsed["summary-chars"] === "string" ? Number(parsed["summary-chars"]) : undefined,
    includeCandidates: Boolean(parsed["include-candidates"]),
    callNumber: typeof parsed["call-number"] === "string" && Number.isFinite(Number(parsed["call-number"]))
      ? Number(parsed["call-number"])
      : undefined
  };
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const brief = await buildGraphBrief(parseArgs(argv));
  console.log(JSON.stringify(brief, null, 2));
}

if (isMainModule(import.meta.url)) {
  await main();
}

function isMainModule(url) {
  if (!process.argv[1]) return false;
  const entryUrl = pathToFileURL(process.argv[1]).href;
  return entryUrl === url || entryUrl.replace(/\.mjs$/, ".ts") === url;
}
