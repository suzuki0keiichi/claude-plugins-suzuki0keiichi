import { confidenceMessage, judgeMatchConfidence } from "./confidence.ts";
import { expandNeighbors, loadGraph, loadRequiredVectorIndex, nodeForOutput, prepareVectorSearch, searchGraph } from "./retrieval.ts";
import { describeVectorIndex } from "./vector.ts";
import { pathToFileURL } from "node:url";

export async function buildEvidencePacket(args) {
  if (!args.request) {
    throw new Error("Missing --request <text>");
  }

  const graph = await loadGraph(args.vault);
  const vectorIndex = await loadRequiredVectorIndex(args.vault, args.vector, args.vectorDelta);
  const vectorDescription = describeVectorIndex(vectorIndex);
  const vectorSearch = await prepareVectorSearch(args.request, { vectorIndex });
  const matches = searchGraph(graph, args.request, {
    types: args.types,
    limit: args.limit,
    ...vectorSearch
  });
  const matchIds = matches.map((match) => match.node.id);
  const neighborEdges = expandNeighbors(graph, matchIds, args.neighbors);
  const matchConfidence = judgeMatchConfidence(matches[0]);

  return {
    request: args.request,
    generated_by: "graphrag/evidence-packet.ts",
    retrieval_policy: {
      search: "alias + normalized text + character ngram + vector",
      vector: vectorDescription,
      vector_provider: vectorDescription.provider,
      vector_provider_capability: vectorDescription.provider_capability,
      types: args.types,
      neighbor_depth: args.neighbors,
      limit: args.limit
    },
    match_confidence: matchConfidence,
    confidence_message: confidenceMessage(matchConfidence),
    referenced_ids: collectReferencedIds(matches, neighborEdges),
    direct_evidence: matches.map((match) => ({
      score: match.score,
      reasons: match.reasons,
      node: nodeForOutput(match.node)
    })),
    graph_context: neighborEdges.map((entry) => ({
      depth: entry.depth,
      relation: entry.edge.type,
      from: nodeForOutput(entry.from),
      to: nodeForOutput(entry.to)
    })),
    answer_instructions: [
      "Use direct_evidence first.",
      "Use graph_context only as supporting context.",
      "referenced_ids lists every node id in this packet — use it as a quick catalog before re-querying.",
      "If match_confidence is 'low' or 'none', try one alternative keyword once; if still no hit, switch to direct code/doc reading instead of repeating graph queries.",
      "Separate confirmed graph facts from inferred work.",
      "If a needed area is absent from the graph, mark it as a temporary investigation gap instead of inventing a persistent node."
    ]
  };
}

// referenced_ids: every node id appearing in this packet (match nodes + neighbor
// endpoints), deduped. Lets a model confirm "what type is this id" without a
// re-query; full description / provenance still comes from reading the node by id.
export function collectReferencedIds(matches: any[], neighborEdges: any[]): string[] {
  const ids = new Set<string>();
  for (const match of matches) ids.add(match.node.id);
  for (const entry of neighborEdges) {
    ids.add(entry.from.id);
    ids.add(entry.to.id);
  }
  return [...ids];
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
