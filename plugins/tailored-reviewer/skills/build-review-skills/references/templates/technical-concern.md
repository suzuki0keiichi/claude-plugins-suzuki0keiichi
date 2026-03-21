# Technical Concern Perspective Template

Use this for the 6 technical concern perspectives (execution-flow, resource-management,
concurrency, security, platform-constraints, implementation-quality).

Fill in {placeholders} with project-specific content from knowledge-base.

```
---
name: {concern_id}
description: >
  Reviews {project_name} code from the {concern_name} perspective.
  Tech stack: {detected_tech_stack}.
---

# {concern_name} Review

## What to Check

{Check items from archetype-checklists.md "Technical Concern Perspectives" section,
filtered to this concern. THEN overlay tech-stack-specific checks from
references/tech-patterns/{stack}.md for each detected stack.}

## Project-Specific Context

{ONLY the knowledge-base entries relevant to this concern.
NOT the full knowledge-base. Select entries where:
- bug-patterns.md mentions issues related to this concern
- pr-review-patterns.md has reviewer comments about this concern
- implementation-principles.md has rules that affect this concern}

## Fact Check (MUST do before output)

For each finding you are about to report, you MUST verify it:

1. **Re-read the actual code** at the location you are about to cite. Do not report from memory.
2. **Prove the issue exists**: find the specific line(s) that demonstrate the problem. If you cannot point to concrete code, drop the finding.
3. **Attempt to disprove**: actively look for guards, checks, or handling elsewhere that might already address this issue (other middleware, service layer, caller code, etc.). If found, drop or downgrade the finding.
4. **Check for false assumptions**: verify your understanding of the framework, library, or pattern being used. If unsure, note uncertainty in Confidence.

Only findings that survive this verification appear in your output.

## Output Format

For each finding:

### [Finding Title]
- **Severity**: Critical / Important / Suggestion
- **Category**: short-term-detriment / long-term-detriment
- **Confidence**: 0-100
- **Location**: file:line (exact line numbers, verified by re-reading)
- **Description**: What is the problem
- **Verification**: The specific code you read that proves this issue. Quote the relevant lines. If the issue is an absence (e.g., missing check), state what you searched for and where.
- **Evidence**: Why you believe this matters for this project (reference knowledge-base entries, bug-patterns, design-principles)
- **Suggestion**: What should be done
```
