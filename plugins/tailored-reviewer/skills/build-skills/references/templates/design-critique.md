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

## Output Format

- **Severity**: Important (design issues are rarely Critical unless security-related)
- **Category**: design-critique
- **Confidence**: 70-90 (design judgments inherently have more uncertainty)
- **Description**: What the design gap is
- **Alternative**: What a better approach might look like
- **Evidence**: Why you believe this matters (reference knowledge-base, similar bugs, design principles)
```
