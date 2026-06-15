// Real git-backed merge deps for vault branches.
//
// A vault branch is just a git branch of the vault's repository. To compare the
// three states we (a) ask git for the split point (merge-base) and (b) load the
// vault as it was at each ref by materialising that ref in a throwaway worktree
// and running the normal vault loader on it. git provides isolation, history and
// the split point for free; the actual graph merge happens at node/edge level
// elsewhere (never via git's text merge).

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GraphLike } from "./diff.ts";
import type { MergeDeps } from "./vault-branch.ts";

const run = promisify(execFile);

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repoDir, ...args]);
  return stdout.trim();
}

export async function gitMergeBase(repoDir: string, refA: string, refB: string): Promise<string> {
  return git(repoDir, ["merge-base", refA, refB]);
}

// Materialise the repo at `ref` in a throwaway worktree, load the vault at
// vaultSubpath via the provided loader, then remove the worktree.
export async function loadGraphFromRef(
  repoDir: string,
  vaultSubpath: string,
  ref: string,
  loadGraph: (vaultDir: string) => Promise<GraphLike>
): Promise<GraphLike> {
  const worktree = await mkdtemp(path.join(tmpdir(), "graphrag-wt-"));
  try {
    await git(repoDir, ["worktree", "add", "--detach", "--quiet", worktree, ref]);
    return await loadGraph(path.join(worktree, vaultSubpath));
  } finally {
    await git(repoDir, ["worktree", "remove", "--force", worktree]).catch(() => {});
    await rm(worktree, { recursive: true, force: true }).catch(() => {});
  }
}

// Build real git-backed merge deps for a vault directory. Derives the repo root
// and the vault's path within it from vaultDir (via git itself, so symlinked
// temp dirs on macOS don't trip up path math).
export async function makeGitMergeDeps(
  vaultDir: string,
  loadGraph: (vaultDir: string) => Promise<GraphLike>
): Promise<MergeDeps> {
  const repoDir = await git(vaultDir, ["rev-parse", "--show-toplevel"]);
  const vaultSubpath = await git(vaultDir, ["rev-parse", "--show-prefix"]); // "" at repo root, else "vault/"
  return {
    resolveSplitPoint: (branchRef, mainRef) => gitMergeBase(repoDir, branchRef, mainRef),
    loadGraphAtRef: (ref) => loadGraphFromRef(repoDir, vaultSubpath, ref, loadGraph)
  };
}
