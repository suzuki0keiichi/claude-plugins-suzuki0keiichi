# Parallel-work branching and semantic merge (vault branch)

The vault is under git, so parallel work on the knowledge graph is isolated on a **vault git branch**. Creating and deleting branches is plain git (the skill does not wrap it). What the skill owns is the **semantic merge** — git's file-level merge misses the graph's semantic conflicts (rephrased duplicates, lineage-free Decisions, etc.), so the merge is done per-node/per-edge by reading meaning.

## Procedure

1. **Branch off**: create a vault git branch and write in isolation on it via `add-*` / `commit-mutation`.
2. **Merge analysis**: `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts branch-merge --branch <ref> [--main main] [--vector <index>]`
   - Reads the 3 states — fork point (git merge-base), branch, and main — surfaces both sides' diffs and conflicts, and returns the spots needing semantic judgment as a **judgment packet** (JSON). **Writes nothing.**
   - `branch_changes` / `main_changes` = what each side changed from the fork point (distilled fields only; not re-summarized). `flagged_conflicts` = the spots to look at closely (labeled mechanical/semantic; **"not flagged ≠ safe"**, so review the whole thing).
3. **Resolve and apply**: read the packet, compose the merged state as a mutation plan, and apply it **to main's vault** via `commit-mutation <plan.json>` (lock/OCC/validation/atomic publish/git commit are guaranteed by the existing path). Consolidate duplicates that state the same judgment in different words into one (supersede/refine); do not leave both.

## Constraints and how to read the output

- `branch-merge` itself is read-only (analysis only).
- Without `--vector`, semantic-proximity duplicate detection is limited to structural signals only (made explicit in the output's `similarity_detection`).
- Point the application target (step 3's plan) at main's vault. Do not write on the branch vault and then `git merge` into main (that would delegate semantic conflicts to git).
