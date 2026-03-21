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

1. Classify each finding by source perspective — do NOT rely on the finding's self-declared category:

   **Short-term** (bugs, security, correctness — goes to short-term file):
   - All findings from: execution-flow, resource-management, concurrency, security, platform-constraints, implementation-quality
   - Exception: if these perspectives produce a Root Cause Analysis finding, that goes to long-term

   **Long-term** (maintainability, design, strategy — goes to long-term file):
   - All findings from: code-health, strategic-alignment
   - All findings from domain perspectives
   - All Design Critique findings (Phase 1.7)
   - All Root Cause Analysis findings (regardless of source perspective)
2. For each category separately:
   a. Merge findings, replacing contradicted findings with debate resolutions
   b. Deduplicate: merge findings describing the same issue from different perspectives. Keep all perspective names. Do NOT discard detail.
   c. Apply filtering thresholds (short-term and long-term have DIFFERENT thresholds):

   **Short-term filtering:**
   | Severity | Rule |
   |----------|------|
   | Critical | ALL — no filtering, regardless of Confidence |
   | Important | Confidence ≥ 80 |
   | Suggestion | Confidence ≥ 50, top 10 by Confidence |

   **Long-term filtering:**
   | Severity | Rule |
   |----------|------|
   | Critical | ALL — no filtering, regardless of Confidence |
   | Important | Confidence ≥ 60 |
   | Suggestion | Confidence ≥ 40, top 10 by Confidence |

   Long-term thresholds are lower because design judgments inherently carry more uncertainty than bug detection. A Confidence 65 design concern is still worth reporting.

   d. Sort by severity (Critical → Important → Suggestion)
3. **Root Cause Analysis** (long-term file only): for each short-term Critical/Important finding, ask: "Why was this bug possible? Is there a design issue in the existing code that makes this class of bug likely?" If yes, add a root-cause finding to the long-term report linking the bug to the structural issue. Use bug-patterns.md as a starting point — if this area has repeated bugs, explain WHY it keeps producing them.
4. Calculate scores (see Scoring section)
5. Write BOTH files

## Scoring

Calculate two independent scores. Each is 0-100 (higher = better).

### Short-term Score (bugs, security, correctness)

Start at 100, deduct:
- Each Critical finding: -10
- Each Important finding: -3
- Each Suggestion: -1
- **No minimum** — negative scores are valid and indicate severe issues

### Long-term Score (maintainability, tech debt, design)

Start at 100, deduct:
- Each Critical long-term detriment: -10
- Each Important long-term detriment: -3
- Each long-term Suggestion: -1
- Each Design Critique finding: -3
- Each 構造的背景 finding: -3
- **No minimum** — negative scores are valid

## Short-term Report Format

# Short-term Review: [target name]

## Score

| Short-term (bugs, security) | XX | 🟢 ≥80 / 🟡 50-79 / 🔴 0-49 / ⚫ <0 |

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

| Long-term (maintainability) | XX | 🟢 ≥80 / 🟡 50-79 / 🔴 0-49 / ⚫ <0 |

## Summary
- Review type, target, execution date
- Perspectives used: N (list)
- Critical: N, Important: N, Suggestion: N
- Design critique: N
- 短期的な問題の構造的背景: N
- **Per-perspective details**: `reviews/perspectives/{date}-{target}/`

## 短期的な問題の構造的背景

以下は、short-termレビューで検出されたCritical/Important級の問題について、「なぜこの問題がそもそも起きうる構造になっているのか」を分析したものです。個別のバグ修正はshort-termレポートを参照してください。ここでは、同種の問題が繰り返されないための構造的な改善を提案します。

(For each major short-term finding, explain the structural root cause, link to bug-patterns.md if this area is a known hotspot, and propose structural fixes that prevent the entire class of bug.)

## 設計上の懸念
(目的と実装のギャップ、欠落している考慮事項、代替アプローチの提案)

## 長期的な問題

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
