# Consolidation Template

Fill in {placeholders} with project-specific content.

```
---
name: consolidation
description: >
  Produces the final review report for {project_name} by consolidating
  all perspective results and debate resolutions into two separate files.
---

# Consolidation: Final Report Generation

## MANDATORY: File Output (do this FIRST)

**Before generating the report content**, prepare TWO output files:

1. Create the `reviews/` directory if it does not exist
2. Determine the file names:
   - `reviews/{YYYY-MM-DD}-{type}-{target}-short-term.md` — bugs, security, correctness
   - `reviews/{YYYY-MM-DD}-{type}-{target}-long-term.md` — maintainability, tech debt, design
3. After generating both reports below, you MUST write BOTH files. Do NOT skip either.

**This is non-negotiable. A review without saved files is an incomplete review.**

## Input

- All perspective findings (Phase 1 results)
- Debate resolutions (if any)
- Health score data (if available)
- Raw perspective outputs are already saved to `reviews/perspectives/` by the orchestrator

## Process

1. Classify each finding: short-term-detriment or long-term-detriment. Design Critique findings go to long-term.
2. For each category separately:
   a. Merge findings, replacing contradicted findings with debate resolutions
   b. Filter: exclude findings with Confidence < 80
   c. Deduplicate: merge findings describing the same issue from different perspectives. Keep all perspective names. Do NOT discard detail.
   d. Sort by severity (Critical → Important → Suggestion)
3. **Root Cause Analysis** (long-term file only): for each short-term Critical/Important finding, ask: "Why was this bug possible? Is there a design issue in the existing code that makes this class of bug likely?" If yes, add a root-cause finding to the long-term report linking the bug to the structural issue. Use bug-patterns.md as a starting point — if this area has repeated bugs, explain WHY it keeps producing them.
4. Calculate scores (see Scoring section)
5. Write BOTH files

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
- Each root-cause finding: -5
- Minimum: 0

## Short-term Report Format

# Short-term Review: [target name]

## Score

| Short-term (bugs, security) | XX/100 | 🟢 ≥80 / 🟡 50-79 / 🔴 <50 |

## Summary
- Review type, target, execution date
- Perspectives used: N (list)
- Critical: N, Important: N, Suggestion: N
- Findings dropped by fact-check: N
- Findings dropped by workspace reconciliation: N (PR reviews only)
- **Per-perspective details**: `reviews/perspectives/{date}-{target}/`

## Critical
(each finding in structured format with Verification field. Never omit.
For each finding, list ALL detecting perspectives and their confidence levels.)

## Important
(structured format — preserve finding detail, do not over-compress.
Each finding should include: location, description, verification code, suggestion.
Merge duplicates across perspectives but keep all perspective names.)

## Suggestions
(structured format — NOT just a one-line list. Include location and brief description.)

## Fact-Check Log
(findings dropped or downgraded, with reason.)

## Debate Notes
(only if debate occurred)

## Long-term Report Format

# Long-term Review: [target name]

## Score

| Long-term (maintainability) | XX/100 | 🟢 ≥80 / 🟡 50-79 / 🔴 <50 |

## Summary
- Review type, target, execution date
- Perspectives used: N (list)
- Critical: N, Important: N, Suggestion: N
- Design critique: N
- Root cause analysis: N
- **Per-perspective details**: `reviews/perspectives/{date}-{target}/`

## Root Cause Analysis
For each major short-term bug, why was it structurally possible?
Link to bug-patterns.md if this area is a known hotspot.
(This section bridges short-term bugs to long-term design issues.)

## Design Critique
(purpose-implementation gaps, omissions, alternative approaches)

## Long-term Detriments

### Critical
(structured format)

### Important
(structured format — same detail level as short-term)

### Suggestions
(structured format)

## Knowledge Base References
(which knowledge-base entries were consulted, and by which perspectives)

## Health Score Data
(if available: relevant trends for reviewed areas)
```
