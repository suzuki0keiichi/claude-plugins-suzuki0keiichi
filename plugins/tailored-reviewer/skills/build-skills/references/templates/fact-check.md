# Fact Check Template

This is read by the orchestrator during Phase 1.5.

```
---
name: fact-check
description: >
  Cross-perspective fact checking for {project_name}.
  Verifies findings against workspace code, reconciles PR diff vs merged state,
  and validates single-source findings.
---

# Fact Check

## Step A: Workspace Verification (ALL findings)

For EVERY finding with Severity Critical or Important:
1. Re-read the cited code location in `workspace/`
2. Confirm the finding's Verification field matches the actual code
3. If the code does not match the finding: **drop the finding**
4. If mitigating code exists elsewhere: downgrade Severity or drop

## Step B: PR Diff vs Workspace Reconciliation (PR Reviews ONLY — skip in backtest)

**Skip this step entirely if running in backtest mode.** In backtest mode, the workspace is intentionally set to the bug-introducing commit state, and reconciliation against the default branch would falsely drop all findings.

**PR diff data location**: The orchestrator pre-fetches PR data in Step 0.6. Use the Read tool to access:
- `reviews/perspectives/{YYYY-MM-DD}-{target}/pr-diff.txt` — full diff
- `reviews/perspectives/{YYYY-MM-DD}-{target}/pr-info.txt` — PR description
- `reviews/perspectives/{YYYY-MM-DD}-{target}/pr-meta.json` — PR metadata (base branch, state, merged date)
Do NOT run `gh pr diff` or `gh pr view` — the data is already saved.

**Workspace branch context**: The orchestrator aligns the workspace to the PR's base branch in Step 0.6. This means:
- `workspace/` reflects the base branch state (correct dependency versions, existing code patterns)
- Perspectives that read dependency files (poetry.lock, package.json, go.mod, etc.) get the base branch versions, not a stale release branch

**Reconciliation for MERGED PRs**: Check `pr-meta.json` — if `merged` is non-null, the PR is merged and the base branch includes the PR changes plus subsequent commits. For each finding:

1. Read the CURRENT version of the cited file in `workspace/`
2. Compare the specific lines cited in the finding against the current workspace code
3. If the issue described in the finding is **already fixed** in the workspace version:
   - **Drop the finding entirely** — do not report fixed issues
4. If the issue is **partially fixed** in the workspace:
   - Update the finding to reflect only the remaining issue
   - Note: "Partially addressed in merged version"
5. If the issue **still exists** in the workspace:
   - Keep the finding as-is

**Reconciliation for OPEN PRs**: If `merged` is null, the PR is not yet merged. The workspace (base branch) does NOT contain the PR changes. Skip diff-vs-workspace reconciliation — the PR diff is the source of truth. Still perform Step A (verify cited code locations exist in the diff).

**Every PR review finding MUST survive this reconciliation step. Findings that cite code no longer present in workspace are false positives and damage review credibility.**

## Step C: Cross-Source Validation

Findings detected by only ONE perspective (single-source) have higher false-positive risk:
- Apply extra scrutiny: actively search for guards, checks, or handling elsewhere
- Multi-source findings have implicit cross-validation and can skip this step
```
