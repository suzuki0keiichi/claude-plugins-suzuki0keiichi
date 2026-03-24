# Design Critique Template

This is read by the orchestrator during Phase 1.7.

```
---
name: design-critique
description: >
  Holistic design evaluation for {project_name}.
  Evaluates purpose-implementation gaps, omissions, design alternatives,
  and structural root causes of bugs.
---

# Design Critique

Evaluate the change holistically after fact-checking individual findings:

## 0. PR Description Context (PR reviews only)

Read `pr-info.txt` thoroughly before any analysis. PR descriptions often contain:
- Rationale for design decisions
- Links to discussions (Slack threads, tickets, design docs) documenting consensus
- Explicit trade-off explanations

When a design decision has rationale or consensus links in the PR description, do NOT flag it as "needs documentation", "needs confirmation", or "should verify". Only flag if the rationale is actually insufficient or incorrect.

## 1. Purpose vs Implementation Gap

Read the PR description/commit message. Does the implementation actually achieve the stated goal? Are there gaps between what was promised and what was delivered?

## 2. Omission Detection

What SHOULD have been changed but wasn't?
- If a new wrapper/abstraction was introduced, does ALL existing code use it?
- If a security boundary was established, is it comprehensive?
- Are there related files that need corresponding changes?
- **Deleted code feature coverage**: if the PR deletes files or code blocks, list each feature/behavior the deleted code provided. Then verify each feature is covered by the new code. Missing features are UX regression candidates. Pay special attention to user-facing notifications, warning messages, grace periods, and fallback behaviors.

## 3. Design Alternative Analysis

Is this the right approach?
- Are there simpler solutions that achieve the same goal?
- Does this approach create new maintenance burden?
- Does it solve the symptom or the root cause?

## 4. Coverage Assessment

What edge cases aren't handled?
- What happens with unexpected input?
- What happens under failure conditions?
- What happens when upstream/downstream systems change?

## 5. Structural Root Cause

If Phase 1 found Critical/Important bugs, ask: why was this bug structurally possible? Look beyond the diff — the code AROUND the bug (existing naming, types, API design) may be the real problem. Check bug-patterns.md: if this area is a known hotspot, explain WHY it keeps producing bugs, not just THAT it does.

## 6. Spec Conformance Check

**Skip this section if `reviews/perspectives/{YYYY-MM-DD}-{target}/spec-context.md` is empty or says "No spec context available".**

Read the spec context file. For each requirement, acceptance criterion, or agreed decision found in the spec:

1. **Traced**: Is this requirement implemented in the diff? Cite the specific file:line where it is addressed. If the requirement is about existing behavior that should be preserved, verify it is not broken by the diff.
2. **Faithful**: Does the implementation match the spec's intent — not just "something was done" but "the right thing was done"? Watch for subtle deviations: spec says "must validate X" but code only checks for null, not format.
3. **Complete**: Are edge cases or error conditions mentioned in the spec handled in the implementation? Specs often describe happy path + a few exceptions — check each.
4. **Unconsidered**: Are there spec requirements that appear unaddressed by the diff AND were not flagged by any Phase 1 perspective? These are the highest-value findings — requirements that fell through the cracks entirely.

Report spec conformance gaps as findings:
- **Severity**: Critical (spec requirement missing entirely or contradicted) or Important (partially implemented, edge case missing)
- **Category**: spec-conformance
- **Evidence**: Quote the specific spec requirement AND show what is missing or different in the code

## Output Format

- **Severity**: Important (design issues are rarely Critical unless security-related)
- **Category**: design-critique
- **Confidence**: 70-90 (design judgments inherently have more uncertainty)
- **Description**: What the design gap is
- **Alternative**: What a better approach might look like
- **Evidence**: Why you believe this matters (reference knowledge-base, similar bugs, design principles)
```
