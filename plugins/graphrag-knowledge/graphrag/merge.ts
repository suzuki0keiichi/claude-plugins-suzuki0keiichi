import { graphDiff, type GraphDiff, type GraphLike } from "./diff.ts";

export type MergeDeltas = {
  branchDelta: GraphDiff;
  mainDelta: GraphDiff;
};

export function computeMergeDeltas(
  base: GraphLike,
  branchNow: GraphLike,
  mainNow: GraphLike
): MergeDeltas {
  return {
    branchDelta: graphDiff(base, branchNow),
    mainDelta: graphDiff(base, mainNow)
  };
}
