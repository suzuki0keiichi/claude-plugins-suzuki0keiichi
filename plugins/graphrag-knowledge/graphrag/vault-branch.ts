// Orchestrates a vault-branch merge.
//
// Loads the three states — split point (git merge-base), branch now, main now —
// via INJECTED deps (so this is unit-testable without git or a real vault), runs
// the pure analyzeMerge, and builds a lean judgment packet for the agent (LLM)
// to resolve the merge semantically.
//
// The packet hands the agent both sides' changes projected to the graph's own
// distilled fields (no lossy re-summarisation), plus the flagged conflict zones
// as priority hints. git/text merge is never the graph merge; the merged result
// comes back as a mutation plan, is validated structurally, then applied to main.

import type { ClassifiedConflictZone } from "./conflict.ts";
import type { GraphDiff, GraphLike } from "./diff.ts";
import {
  analyzeMerge,
  projectNodeForJudgment,
  type MergeAnalysis
} from "./merge-analysis.ts";

export type MergeDeps = {
  // git merge-base of the two refs = the point where the branch diverged.
  resolveSplitPoint: (branchRef: string, mainRef: string) => Promise<string>;
  // load the vault graph as it was at a given git ref.
  loadGraphAtRef: (ref: string) => Promise<GraphLike>;
};

export type PrepareMergeArgs = {
  branchRef: string;
  mainRef: string;
  vectorIndex?: unknown;
  vectorSimilarityThreshold?: number;
};

export type ProjectedDelta = {
  nodes: {
    added: GraphLike["nodes"];
    removed: GraphLike["nodes"];
    modified: Array<{ id: string; propertyDiff: unknown }>;
  };
  edges: GraphDiff["edges"];
};

export type ConflictRef = Record<string, unknown> & { signal: string };

export type JudgmentPacket = {
  instructions: string[];
  summary: MergeAnalysis["summary"];
  branch_changes: ProjectedDelta;
  main_changes: ProjectedDelta;
  flagged_conflicts: ConflictRef[];
};

export type PrepareMergeResult = {
  splitRef: string;
  analysis: MergeAnalysis;
  packet: JudgmentPacket;
};

export async function prepareMerge(
  args: PrepareMergeArgs,
  deps: MergeDeps
): Promise<PrepareMergeResult> {
  const splitRef = await deps.resolveSplitPoint(args.branchRef, args.mainRef);
  const base = await deps.loadGraphAtRef(splitRef);
  const branchNow = await deps.loadGraphAtRef(args.branchRef);
  const mainNow = await deps.loadGraphAtRef(args.mainRef);
  const analysis = analyzeMerge(base, branchNow, mainNow, {
    vectorIndex: args.vectorIndex,
    vectorSimilarityThreshold: args.vectorSimilarityThreshold
  });
  return { splitRef, analysis, packet: buildJudgmentPacket(analysis) };
}

const INSTRUCTIONS = [
  "branch_changes / main_changes are what each side changed since the split point. Produce ONE merge resolution as a mutation plan (reason, nodes, edges) for the combined graph.",
  "flagged_conflicts marks zones most likely to need meaning-level judgment — review those closely, but also sanity-check the rest; not-flagged does NOT guarantee safe.",
  "If both sides express the same decision in different words, merge into one (supersede/refine as appropriate) instead of keeping duplicates.",
  "The result is validated structurally and applied to main. Do not invent nodes without source backing."
];

export function buildJudgmentPacket(analysis: MergeAnalysis): JudgmentPacket {
  return {
    instructions: INSTRUCTIONS,
    summary: analysis.summary,
    branch_changes: projectDelta(analysis.deltas.branchDelta),
    main_changes: projectDelta(analysis.deltas.mainDelta),
    // all conflicts (with the triage label), not only semantic ones — nothing hidden.
    flagged_conflicts: analysis.conflicts.map(summarizeConflictZone)
  };
}

function projectDelta(delta: GraphDiff): ProjectedDelta {
  return {
    nodes: {
      added: delta.nodes.added.map(projectNodeForJudgment),
      removed: delta.nodes.removed.map(projectNodeForJudgment),
      modified: delta.nodes.modified.map((mod) => ({ id: mod.id, propertyDiff: mod.propertyDiff }))
    },
    edges: delta.edges
  };
}

// Lean reference to a conflict zone: ids + metadata only. The full (projected)
// node content lives once in branch_changes / main_changes; the agent looks it
// up by id rather than carrying duplicated node bodies here.
function summarizeConflictZone(zone: ClassifiedConflictZone): ConflictRef {
  switch (zone.signal) {
    case "node_co_modified":
      return { signal: zone.signal, nodeId: zone.nodeId, resolution: zone.resolution };
    case "edge_target_co_added":
      return { signal: zone.signal, edgeType: zone.edgeType, target: zone.target, resolution: zone.resolution };
    case "decision_without_lineage":
      return { signal: zone.signal, nodeId: zone.nodeId, side: zone.side, resolution: zone.resolution };
    case "decision_vector_similar":
      return {
        signal: zone.signal,
        branchNodeId: zone.branchNodeId,
        mainNodeId: zone.mainNodeId,
        similarity: zone.similarity,
        resolution: zone.resolution
      };
  }
}
