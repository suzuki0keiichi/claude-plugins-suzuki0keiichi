import { expandNeighbors, loadGraph, loadRequiredVectorIndex, nodeForOutput, prepareVectorSearch, searchGraph } from "./retrieval.ts";
import { describeVectorIndex } from "./vector.ts";

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (!args.query) {
    throw new Error("Missing --query <text>");
  }

  const graph = await loadGraph(args.vault);
  const vectorIndex = await loadRequiredVectorIndex(args.vault, args.vector, args.vectorDelta);
  const vectorSearch = await prepareVectorSearch(args.query, { vectorIndex });
  const matches = searchGraph(graph, args.query, {
    types: args.types,
    limit: args.limit,
    ...vectorSearch
  });
  const neighborEdges = expandNeighbors(
    graph,
    matches.map((match) => match.node.id),
    args.neighbors
  );

  console.log(JSON.stringify({
    query: args.query,
    limit: args.limit,
    neighbors: args.neighbors,
    vector: describeVectorIndex(vectorIndex),
    matches: matches.map((match) => ({
      score: match.score,
      reasons: match.reasons,
      node: nodeForOutput(match.node)
    })),
    neighborEdges: neighborEdges.map((entry) => ({
      depth: entry.depth,
      edge: {
        id: entry.edge.id,
        type: entry.edge.type,
        from: entry.edge.from,
        to: entry.edge.to
      },
      from: nodeForOutput(entry.from),
      to: nodeForOutput(entry.to)
    }))
  }, null, 2));
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
    query: typeof parsed.query === "string" ? parsed.query : "",
    vault: typeof parsed.vault === "string" ? parsed.vault : process.env.GRAPHRAG_VAULT_DIR,
    vector: typeof parsed.vector === "string" ? parsed.vector : undefined,
    vectorDelta: typeof (parsed.vectorDelta ?? parsed["vector-delta"]) === "string"
      ? parsed.vectorDelta ?? parsed["vector-delta"]
      : undefined,
    limit: typeof parsed.limit === "string" ? Number(parsed.limit) : 10,
    neighbors: typeof parsed.neighbors === "string" ? Number(parsed.neighbors) : 1,
    types: typeof parsed.types === "string" ? parsed.types.split(",").filter(Boolean) : []
  };
}

// Standalone entry (preserve backward compat for direct invocation)
if (process.argv[1] && process.argv[1].endsWith("search.ts")) {
  await main();
}
