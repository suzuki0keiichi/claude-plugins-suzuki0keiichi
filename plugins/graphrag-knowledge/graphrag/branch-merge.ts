// CLI entry for `branch-merge`: semantic merge analysis of a vault git branch.
//
// Loads the three states (split point, branch, main) from real git, runs the
// merge analysis, and prints the judgment packet for the agent to resolve. It
// does NOT write anything — the agent reviews the packet, authors a resolution
// mutation plan, and applies it to main via the normal commit-mutation flow.
// Branch create/delete are plain git on the vault; the skill owns the merge.

import { pathToFileURL } from "node:url";
import { importVault } from "./import-vault.ts";
import { loadVectorIndex } from "./retrieval.ts";
import { prepareMerge } from "./vault-branch.ts";
import { makeGitMergeDeps } from "./vault-git.ts";

export function parseArgs(argv: string[]) {
  const parsed: Record<string, string | true> = {};
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
    vault: typeof parsed.vault === "string" ? parsed.vault : process.env.GRAPHRAG_VAULT_DIR,
    branch: typeof parsed.branch === "string" ? parsed.branch : undefined,
    main: typeof parsed.main === "string" ? parsed.main : "main",
    vector: typeof parsed.vector === "string" ? parsed.vector : undefined
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (!args.vault) {
    throw new Error("vault directory not specified. Pass --vault <dir> or set GRAPHRAG_VAULT_DIR.");
  }
  if (!args.branch) {
    throw new Error("Missing --branch <ref> (the vault git branch to merge into --main, default main).");
  }

  // Optional: the live vector index powers duplicate-by-meaning detection. It
  // reflects one vault state, so cross-branch coverage is best-effort; absence
  // is reported (not silently dropped) so the agent knows the limitation.
  const vectorIndex = args.vector ? await loadVectorIndex(args.vector) : undefined;

  const deps = await makeGitMergeDeps(args.vault, async (dir) => importVault(dir));
  const result = await prepareMerge(
    { branchRef: args.branch, mainRef: args.main, vectorIndex },
    deps
  );

  const out = {
    split_point: result.splitRef,
    branch: args.branch,
    main: args.main,
    similarity_detection: vectorIndex
      ? "on"
      : "off — no --vector index given; duplicate-by-meaning relies on structural signals only",
    ...result.packet
  };
  console.log(JSON.stringify(out, null, 2));
}

function isMainModule(url: string) {
  if (!process.argv[1]) return false;
  const entryUrl = pathToFileURL(process.argv[1]).href;
  return entryUrl === url || entryUrl.replace(/\.mjs$/, ".ts") === url;
}
if (isMainModule(import.meta.url)) {
  await main();
}
