import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { makeGitMergeDeps } from "./vault-git.ts";
import { prepareMerge } from "./vault-branch.ts";

const run = promisify(execFile);
const git = (dir: string, args: string[]) => run("git", ["-C", dir, ...args]);

// Stand-in vault loader: reads graph.json so the test exercises the real git
// worktree mechanics without depending on the full Markdown vault format.
const loadJsonGraph = async (vaultDir: string) =>
  JSON.parse(await readFile(path.join(vaultDir, "graph.json"), "utf8"));

async function writeGraph(dir: string, graph: unknown) {
  await writeFile(path.join(dir, "graph.json"), JSON.stringify(graph), "utf8");
}

test("makeGitMergeDeps + prepareMerge load three real git states end-to-end", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "graphrag-repo-"));
  try {
    await git(repo, ["init", "--quiet", "-b", "main"]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "tester"]);

    // base = split point
    await writeGraph(repo, { nodes: [{ id: "decision:a", type: "Decision", title: "old" }], edges: [] });
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "--quiet", "-m", "base"]);

    // branch edits the title
    await git(repo, ["checkout", "--quiet", "-b", "kb/x"]);
    await writeGraph(repo, { nodes: [{ id: "decision:a", type: "Decision", title: "branch" }], edges: [] });
    await git(repo, ["commit", "--quiet", "-am", "branch edit"]);

    // main edits the same title differently
    await git(repo, ["checkout", "--quiet", "main"]);
    await writeGraph(repo, { nodes: [{ id: "decision:a", type: "Decision", title: "main" }], edges: [] });
    await git(repo, ["commit", "--quiet", "-am", "main edit"]);

    const deps = await makeGitMergeDeps(repo, loadJsonGraph);
    const res = await prepareMerge({ branchRef: "kb/x", mainRef: "main" }, deps);

    // both sides edited the same property of the same node -> semantic conflict
    assert.equal(res.analysis.summary.branch.nodesModified, 1);
    assert.equal(res.analysis.summary.main.nodesModified, 1);
    assert.equal(res.analysis.hasSemanticConflicts, true);
    assert.ok(res.packet.flagged_conflicts.some((c) => c.signal === "node_co_modified"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
