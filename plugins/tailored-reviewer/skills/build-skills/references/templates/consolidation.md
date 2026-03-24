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

## Output Language

Write the entire report in the language specified by the orchestrator's `Output language` parameter. If not specified, default to English. All section headers, descriptions, and analysis text must be in the output language. Code references (file paths, variable names, etc.) remain in their original form.

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
   - All Design Critique findings (Phase 1.7) — EXCEPT spec-conformance category (see below)
   - All Root Cause Analysis findings (regardless of source perspective)

   **Spec Conformance** (from Phase 1.7 Design Critique, category: spec-conformance):
   - Critical/Important spec-conformance findings → **short-term** (missing or wrong requirements are functional gaps, equivalent to bugs)
   - Suggestion-level spec-conformance findings → **long-term** (minor deviations are design concerns)
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
- Each Structural Root Cause finding: -3
- **No minimum** — negative scores are valid

## Report Format

**ALL section headers and prose MUST be written in the output language.** The section names below are structural references — translate them. For example, if output language is Japanese: "Score" → "スコア", "Summary" → "概要", "Critical" → "クリティカル", "Findings Overview" → "検出結果一覧", etc.

Code references (file paths, variable names, code quotes) remain in their original form.

### Short-term Report

```
# [Short-term Review title in output language]: [target name]

## [Score]

| [Short-term (bugs, security)] | XX | 🟢 ≥80 / 🟡 50-79 / 🔴 0-49 / ⚫ <0 |

## [Summary]
- Review type, target, execution date
- Perspectives used: N (list)
- Critical: N, Important: N, Suggestion: N
- Findings dropped by fact-check: N
- Findings dropped by workspace reconciliation: N (PR reviews only)
- Per-perspective details: `reviews/perspectives/{date}-{target}/`

## [Findings Overview] (table — MUST include for readability)

| # | [Severity] | [Location] | [Title] | [Perspectives] | [Confidence] |
|---|------------|------------|---------|----------------|-------------|
| [S1](#s1) | Critical | file:line | Brief title | security, exec-flow | 95 |
| [S2](#s2) | Important | file:line | Brief title | concurrency | 85 |
| ... | ... | ... | ... | ... | ... |

## [Finding Details]

### <a id="s1"></a>S1: [Finding Title]
(structured format with Verification field. Never omit.
List ALL detecting perspectives and their confidence levels.)

### <a id="s2"></a>S2: [Finding Title]
(structured format — preserve finding detail, do not over-compress.
Each finding: location, description, verification code, suggestion.
Merge duplicates across perspectives but keep all perspective names.)

## [Fact-Check Log]
(findings dropped or downgraded, with reason.)

## [Debate Notes]
(only if debate occurred)
```

### Long-term Report

```
# [Long-term Review title in output language]: [target name]

## [Score]

| [Long-term (maintainability)] | XX | 🟢 ≥80 / 🟡 50-79 / 🔴 0-49 / ⚫ <0 |

## [Summary]
- Review type, target, execution date
- Perspectives used: N (list)
- Critical: N, Important: N, Suggestion: N
- Design critique: N
- Structural Root Causes: N
- Per-perspective details: `reviews/perspectives/{date}-{target}/`

## [Findings Overview] (table — MUST include)

| # | [Severity] | [Category] | [Location] | [Title] | [Confidence] |
|---|------------|------------|------------|---------|-------------|
| [L1](#l1) | Critical | root-cause | file:line | Brief title | 90 |
| [L2](#l2) | Important | design | file:line | Brief title | 75 |
| ... | ... | ... | ... | ... | ... |

Category values: root-cause, design, long-term-issue, spec-conformance

## [Structural Root Causes of Short-term Issues]

For each Critical/Important finding from the short-term report, analyze WHY the issue was structurally possible. Individual bug fixes belong in the short-term report. Here, propose structural improvements to prevent the entire class of bug from recurring.

## [Design Concerns]
(Purpose-implementation gaps, missing considerations, alternative approach proposals)

## [Long-term Issue Details]

### <a id="l1"></a>L1: [Finding Title]
(structured format)

### <a id="l2"></a>L2: [Finding Title]
(structured format — same detail level as short-term)

## [Knowledge Base References]
(which knowledge-base entries were consulted, and by which perspectives)

## [Health Score Data]
(if available: relevant trends for reviewed areas)
```
```
