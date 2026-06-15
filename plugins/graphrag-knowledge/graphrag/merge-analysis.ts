// Pure, storage-agnostic merge analysis for vault branches.
//
// Given three graph snapshots — the split point (base), the branch now, and
// main now — this computes the per-side diffs, detects + classifies conflicts,
// and splits them into "mechanically safe" vs "needs meaning-level judgment".
//
// IMPORTANT: the mechanical/semantic split is a TRIAGE for prioritisation, not
// a proof of safety. "No semantic conflict detected" does NOT guarantee the
// merge is semantically safe — the detectors only catch known risky shapes.
// The caller hands the (small) projected diff to an LLM for the actual meaning
// judgment, and validates the result structurally (validateGraph) before
// applying. git/text merge is never used as the graph merge.

import {
  classifyConflictZones,
  detectStructuralConflicts,
  type ClassifiedConflictZone
} from "./conflict.ts";
import type { GraphLike, GraphNode } from "./diff.ts";
import { computeMergeDeltas, type MergeDeltas } from "./merge.ts";

export type DeltaSummary = {
  nodesAdded: number;
  nodesRemoved: number;
  nodesModified: number;
  edgesAdded: number;
  edgesRemoved: number;
  edgesModified: number;
};

export type MergeAnalysis = {
  deltas: MergeDeltas;
  conflicts: ClassifiedConflictZone[];
  mechanicalConflicts: ClassifiedConflictZone[];
  semanticConflicts: ClassifiedConflictZone[];
  hasSemanticConflicts: boolean;
  summary: {
    branch: DeltaSummary;
    main: DeltaSummary;
    conflicts: { total: number; mechanical: number; semantic: number };
  };
};

export type AnalyzeMergeOptions = {
  vectorIndex?: unknown;
  vectorSimilarityThreshold?: number;
};

export function analyzeMerge(
  base: GraphLike,
  branchNow: GraphLike,
  mainNow: GraphLike,
  options: AnalyzeMergeOptions = {}
): MergeAnalysis {
  const deltas = computeMergeDeltas(base, branchNow, mainNow);
  const conflicts = classifyConflictZones(detectStructuralConflicts(deltas, options));
  const mechanicalConflicts = conflicts.filter((zone) => zone.resolution === "mechanical");
  const semanticConflicts = conflicts.filter((zone) => zone.resolution === "semantic");

  return {
    deltas,
    conflicts,
    mechanicalConflicts,
    semanticConflicts,
    hasSemanticConflicts: semanticConflicts.length > 0,
    summary: {
      branch: summarizeDelta(deltas.branchDelta),
      main: summarizeDelta(deltas.mainDelta),
      conflicts: {
        total: conflicts.length,
        mechanical: mechanicalConflicts.length,
        semantic: semanticConflicts.length
      }
    }
  };
}

function summarizeDelta(delta: MergeDeltas["branchDelta"]): DeltaSummary {
  return {
    nodesAdded: delta.nodes.added.length,
    nodesRemoved: delta.nodes.removed.length,
    nodesModified: delta.nodes.modified.length,
    edgesAdded: delta.edges.added.length,
    edgesRemoved: delta.edges.removed.length,
    edgesModified: delta.edges.modified.length
  };
}

// Distilled view of a node for meaning-level judgment: keep the graph's own
// already-distilled fields (title / summary / type / state / …) and drop only
// bulky non-meaning noise. This is deterministic field-selection, NOT a lossy
// re-summarisation — the LLM judges from the real fields, not a paraphrase.
const NOISE_FIELDS = new Set(["generated_at", "raw_content"]);

export function projectNodeForJudgment(node: GraphNode): GraphNode {
  const projected: GraphNode = {};
  for (const [key, value] of Object.entries(node ?? {})) {
    if (NOISE_FIELDS.has(key)) continue;
    projected[key] = value;
  }
  return projected;
}
