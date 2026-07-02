import { confidenceMessage, gradeConfidence } from "./confidence.ts";
import { expandNeighbors, loadGraph, loadRequiredVectorIndex, nodeForOutput, prepareVectorSearch, searchGraph } from "./retrieval.ts";
import { describeVectorIndex } from "./vector.ts";
import { pathToFileURL } from "node:url";

// graph_context のノード要約は文脈確認用なので短く切る (全文は direct_evidence /
// 該当ノードの直読みで得る)。
const CONTEXT_SUMMARY_CHARS = 140;

export async function buildEvidencePacket(args) {
  if (!args.request) {
    throw new Error("Missing --request <text>");
  }

  // ask の段上げ (runAsk) は brief で読み込んだ graph / 索引 / query embedding を
  // args 経由で渡してくる (同じ問いを 2 回 embedding せず、vault も 2 回読まない)。
  // 単体実行 (primitive の evidence verb) では従来どおりここで読み込む。
  const graph = args.graphData ?? await loadGraph(args.vault);
  const vectorIndex = args.vectorIndex
    ?? await loadRequiredVectorIndex(args.vault, args.vector, args.vectorDelta);
  const vectorDescription = describeVectorIndex(vectorIndex);
  // R6 multi-query: 呼び出し側が --gist 込みの queryVectors を渡していればそれを使う。
  const vectorSearch = Array.isArray(args.queryVectors) && args.queryVectors.length > 0
    ? { vectorIndex, queryVectors: args.queryVectors }
    : await prepareVectorSearch(args.request, { vectorIndex });
  const matches = searchGraph(graph, args.request, {
    types: args.types,
    limit: args.limit,
    ...vectorSearch
  });
  const matchIds = matches.map((match) => match.node.id);
  const neighborEdges = expandNeighbors(graph, matchIds, args.neighbors);
  const graded = gradeConfidence(matches, { noiseBaseline: vectorIndex?.noise_baseline ?? null });

  return {
    request: args.request,
    generated_by: "graphrag/evidence-packet.ts",
    retrieval_policy: {
      search: "alias + normalized text + character ngram + vector",
      vector: vectorDescription,
      types: args.types,
      neighbor_depth: args.neighbors,
      limit: args.limit
    },
    match_confidence: graded.confidence,
    confidence_message: confidenceMessage(graded.confidence),
    standout: graded.standout,
    // 旧 referenced_ids (packet 内の全ノード id カタログ) は廃止: graph_context.nodes
    // が id キーの表になったので同じ情報の重複だった (id → type/title は表を引く)。
    direct_evidence: matches.map((match) => ({
      score: match.score,
      reasons: match.reasons,
      ...(match.state_note ? { state_note: match.state_note } : {}),
      node: nodeForOutput(match.node)
    })),
    graph_context: buildGraphContext(neighborEdges, new Set(matchIds)),
    answer_instructions:
      "Use direct_evidence first; graph_context (nodes table + edges) is supporting context only. Full field guide: $REF/ask-output-guide.md."
  };
}

// graph_context: 旧形式は edge ごとに from/to の全ノード詳細を再掲していて、同じ
// ノードが最大 3 回ダンプされていた。id をキーにした nodes 表 (1 回だけ・短縮要約・
// null フィールド無し) と、id 参照の細い edges 配列に分ける。excludeIds
// (= direct_evidence の match ノード) は上で全文が出ているので表にも載せない。
export function buildGraphContext(
  neighborEdges: any[],
  excludeIds: Set<string> = new Set()
): { nodes: Record<string, any>; edges: any[] } {
  const nodes: Record<string, any> = {};
  const edges = [];
  for (const entry of neighborEdges) {
    for (const node of [entry.from, entry.to]) {
      if (!node || nodes[node.id] || excludeIds.has(node.id)) continue;
      nodes[node.id] = contextNode(node);
    }
    edges.push({
      depth: entry.depth,
      relation: entry.edge.type,
      from: entry.edge.from,
      to: entry.edge.to
    });
  }
  return { nodes, edges };
}

// 文脈ノードの最小表現: id は表のキー側に出るので値には持たせない。null/欠損
// フィールドは省略し、display / aliases / provenance は文脈用途では出さない。
function contextNode(node: any) {
  const summary = typeof node.summary === "string" && node.summary.length > 0
    ? truncate(node.summary, CONTEXT_SUMMARY_CHARS)
    : null;
  return {
    type: node.type,
    ...(node.title ? { title: node.title } : {}),
    ...(summary ? { summary } : {}),
    ...(node.path ? { path: node.path } : {}),
    ...(node.state ? { state: node.state } : {})
  };
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}


export function parseArgs(argv) {
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
    request: typeof parsed.request === "string" ? parsed.request : "",
    vault: typeof parsed.vault === "string" ? parsed.vault : process.env.GRAPHRAG_VAULT_DIR,
    vector: typeof parsed.vector === "string" ? parsed.vector : undefined,
    vectorDelta: typeof (parsed.vectorDelta ?? parsed["vector-delta"]) === "string"
      ? parsed.vectorDelta ?? parsed["vector-delta"]
      : undefined,
    limit: typeof parsed.limit === "string" ? Number(parsed.limit) : 8,
    neighbors: typeof parsed.neighbors === "string" ? Number(parsed.neighbors) : 1,
    types: typeof parsed.types === "string" ? parsed.types.split(",").filter(Boolean) : []
  };
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const packet = await buildEvidencePacket(parseArgs(argv));
  console.log(JSON.stringify(packet, null, 2));
}

if (isMainModule(import.meta.url)) {
  await main();
}

function isMainModule(url) {
  if (!process.argv[1]) return false;
  const entryUrl = pathToFileURL(process.argv[1]).href;
  return entryUrl === url || entryUrl.replace(/\.mjs$/, ".ts") === url;
}
