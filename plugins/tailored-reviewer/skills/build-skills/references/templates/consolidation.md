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
- Raw perspective outputs are already saved to `reviews/perspectives/` by the orchestrator

## Process

1. Merge all findings, replacing contradicted findings with debate resolutions
2. Filter: exclude findings with Confidence < 80 from the report
3. Count ALL Suggestion-level findings (pre-filter) for health score tracking
4. Sort by severity (Critical → Important → Suggestion)
5. Deduplicate: merge findings that describe the same issue from different perspectives. Keep all detecting perspective names. Do NOT discard the finding detail — merge the descriptions.
6. **Calculate scores** (see Scoring section below)
7. Generate report
8. **Write report to the file path determined above** — confirm the file was written by reading it back

## Scoring

Calculate two independent scores. Each is 0-100 (higher = better).

### Short-term Score (bugs, security, correctness)

Start at 100, deduct:
- Each Critical finding: -20
- Each Important finding: -5
- Each Suggestion: -1
- Minimum: 0

### Long-term Score (maintainability, tech debt, design)

Start at 100, deduct:
- Each Critical long-term detriment: -20
- Each Important long-term detriment: -5
- Each long-term Suggestion: -1
- Each Design Critique finding: -5
- Each code-health finding: -3
- Minimum: 0

These scores are INDEPENDENT. A PR can score 95 short-term (few bugs) but 40 long-term (heavy tech debt). Both scores appear in the report summary.

## Report Format

# Review Report: [target name]

## Scores

| | Score | Verdict |
|--|-------|---------|
| Short-term (bugs, security) | XX/100 | 🟢 ≥80 / 🟡 50-79 / 🔴 <50 |
| Long-term (maintainability) | XX/100 | 🟢 ≥80 / 🟡 50-79 / 🔴 <50 |

## Summary
- Review type, target, execution date
- Perspectives used: N (list)
- Short-term detriments: Critical N, Important N, Suggestion N
- Long-term detriments: Critical N, Important N, Suggestion N
- Design critique findings: N
- Findings dropped by fact-check: N
- Findings dropped by workspace reconciliation: N (PR reviews only)
- **Detailed per-perspective outputs**: `reviews/perspectives/{date}-{target}/`

## Short-term Detriments (bugs, security, performance, cost)

### Critical
(each finding in structured format with Verification field. Never omit.
For each finding, list ALL detecting perspectives and their confidence levels.)

### Important
(structured format — preserve finding detail, do not over-compress.
Each finding should include: location, description, verification code, suggestion.
Merge duplicates across perspectives but keep all perspective names.)

### Suggestions
(structured format — NOT just a one-line list. Include location and brief description.)

## Long-term Detriments (tech debt, design drift, chaos)

### Critical
(structured format)

### Important
(structured format — same detail level as short-term)

### Suggestions
(structured format)

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
