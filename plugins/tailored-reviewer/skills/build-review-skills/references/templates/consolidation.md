# Consolidation Template

Fill in {placeholders} with project-specific content.

```
---
name: consolidation
description: >
  Produces the final review report for {project_name} by consolidating
  all perspective results and debate resolutions.
---

# Consolidation: Final Report Generation

## MANDATORY: File Output (do this FIRST)

**Before generating the report content**, prepare the output file:

1. Create the `reviews/` directory if it does not exist
2. Determine the file name: `reviews/{YYYY-MM-DD}-{type}-{target}.md` (e.g., `reviews/2026-03-20-pr-feature-auth.md`)
3. After generating the report below, you MUST write it to this file. Do NOT skip this step. Do NOT write to any other location (not `meta/`, not inline only).

**This is non-negotiable. A review without a saved file is an incomplete review.**

## Input

- All perspective findings (Phase 1 results)
- Debate resolutions (if any)
- Health score data (if available)

## Process

1. Merge all findings, replacing contradicted findings with debate resolutions
2. Filter: exclude findings with Confidence < 80 from the report
3. Count ALL Suggestion-level findings (pre-filter) for health score tracking
4. Sort by severity (Critical → Important → Suggestion)
5. Deduplicate remaining overlaps
6. Generate report
7. **Write report to the file path determined above** — confirm the file was written by reading it back

## Report Format

# Review Report: [target name]

## Summary
- Review type, target, execution date
- Short-term detriments: Critical N, Important N, Suggestion N
- Long-term detriments: Critical N, Important N, Suggestion N
- Design critique findings: N
- Findings dropped by fact-check: N
- Findings dropped by workspace reconciliation: N (PR reviews only)

## Short-term Detriments (bugs, security, performance, cost)

### Critical
(each finding in structured format with Verification field. Never omit.)

### Important
(structured format)

### Suggestions
(list format)

## Long-term Detriments (tech debt, design drift, chaos)

### Critical
(structured format)

### Important
(structured format)

### Suggestions
(list format)

## Design Critique (purpose-implementation gaps, omissions, alternative approaches)
(findings from Phase 1.7 — these are higher-level observations about design choices, not code-level issues)

## Fact-Check Log
(findings that were dropped or downgraded during Phase 1.5, with reason.
For PR reviews: include findings dropped by workspace reconciliation with explanation of what changed between PR diff and merged code.)

## Debate Notes
(only if debate occurred)

## Knowledge Base References
(which knowledge-base entries were consulted, and by which perspectives)

## Health Score Data
(if available: relevant trends for reviewed areas)
```
