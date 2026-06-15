import assert from "node:assert/strict";
import test from "node:test";
import { buildJudgmentPacket, prepareMerge, type MergeDeps } from "./vault-branch.ts";
import { analyzeMerge } from "./merge-analysis.ts";

test("prepareMerge loads the three states via deps and analyzes them", async () => {
  const base = { nodes: [{ id: "decision:a", type: "Decision", title: "old" }], edges: [] };
  const branchNow = { nodes: [{ id: "decision:a", type: "Decision", title: "branch" }], edges: [] };
  const mainNow = { nodes: [{ id: "decision:a", type: "Decision", title: "main" }], edges: [] };
  const byRef: Record<string, any> = { "split-sha": base, "branch-ref": branchNow, "main": mainNow };

  const loaded: string[] = [];
  const deps: MergeDeps = {
    resolveSplitPoint: async (branchRef, mainRef) => {
      assert.equal(branchRef, "branch-ref");
      assert.equal(mainRef, "main");
      return "split-sha";
    },
    loadGraphAtRef: async (ref) => {
      loaded.push(ref);
      return byRef[ref];
    }
  };

  const res = await prepareMerge({ branchRef: "branch-ref", mainRef: "main" }, deps);

  assert.equal(res.splitRef, "split-sha");
  assert.deepEqual(loaded.sort(), ["branch-ref", "main", "split-sha"]);
  // both sides edited the same property -> a semantic conflict surfaces
  assert.equal(res.analysis.hasSemanticConflicts, true);
  assert.ok(res.packet.flagged_conflicts.some((c) => c.signal === "node_co_modified"));
});

test("buildJudgmentPacket projects nodes (drops noise) and references conflicts by id", () => {
  const analysis = analyzeMerge(
    { nodes: [], edges: [] },
    {
      nodes: [
        { id: "decision:nb", type: "Decision", title: "b", generated_at: "2026-01-01", raw_content: "big source" }
      ],
      edges: []
    },
    { nodes: [], edges: [] }
  );

  const packet = buildJudgmentPacket(analysis);

  const added = packet.branch_changes.nodes.added[0] as Record<string, unknown>;
  assert.equal(added.title, "b");
  assert.equal(added.generated_at, undefined);
  assert.equal(added.raw_content, undefined);
  // a new Decision without lineage is surfaced as a flagged conflict by id
  const flagged = packet.flagged_conflicts.find((c) => c.signal === "decision_without_lineage");
  assert.ok(flagged);
  assert.equal(flagged?.nodeId, "decision:nb");
});

test("buildJudgmentPacket carries the count summary and instructions", () => {
  const g = { nodes: [{ id: "decision:a", type: "Decision", title: "A" }], edges: [] };
  const packet = buildJudgmentPacket(analyzeMerge(g, g, g));
  assert.deepEqual(packet.summary.conflicts, { total: 0, mechanical: 0, semantic: 0 });
  assert.ok(packet.instructions.length > 0);
  assert.deepEqual(packet.flagged_conflicts, []);
});
