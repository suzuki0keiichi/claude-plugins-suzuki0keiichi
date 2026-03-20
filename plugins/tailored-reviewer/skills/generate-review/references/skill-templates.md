# Templates for Generated Review Skills

Use these templates when generating SKILL.md files for a project.
Fill in {placeholders} with project-specific content from knowledge-base.

---

## review-orchestrator/SKILL.md Template

```
---
name: review-orchestrator
description: >
  Orchestrates {project_name} review execution. Determines review type,
  selects perspectives, coordinates parallel review agents, detects
  contradictions, and produces the final review report.
---

# {project_name} Review Orchestrator

## Input Analysis

Determine review type from input:

| Input | Type | Perspectives to Activate |
|-------|------|-------------------------|
| PR diff + description | PR Review | {pr_perspectives} |
| Design document | Design Review | {design_perspectives} |
| Module/area name | Code Health Review | {health_perspectives} |
| Incident info + code | Incident Review | {incident_perspectives} |

## Execution

### Phase 1: Parallel Independent Review

Dispatch each perspective as an Agent:
{for each perspective}
- Agent: "{perspective_name}" — Read .claude/skills/perspectives/{perspective_id}/SKILL.md and execute
{end for}

Collect all agent results. Each returns findings in unified format.

### Phase 2: Contradiction Detection

Scan all findings for:
- Same location, different severity → contradiction
- Conflicting suggestions for same issue → contradiction
- Duplicate findings across perspectives → merge candidates

If contradictions found: dispatch debate agent with contradiction pairs.
If no contradictions: skip to Phase 3.

### Phase 3: Consolidation

Dispatch consolidation agent with:
- All Phase 1 results (preserved separately)
- Debate results (if any)
- Health score data (if available at health/scores/)

Output: final review report.
```

---

## perspectives/{name}/SKILL.md Template

```
---
name: {perspective_id}
description: >
  Reviews {project_name} code from the {perspective_name} perspective.
  Focuses on: {focus_summary}.
---

# {perspective_name} Review

## Context

{Why this perspective matters for this specific project. Reference knowledge-base entries.}

## What to Check

### Short-term Detriments
{Specific checks derived from bug-patterns.md and archetype requirements}

### Long-term Detriments
{Specific checks derived from design-principles.md and project trajectory}

## Project-Specific Patterns

{Patterns extracted from pr-review-patterns.md and bug-patterns.md
that are specific to this project, not generic best practices}

## Output Format

For each finding:

### [Finding Title]
- **Severity**: Critical / Important / Suggestion
- **Category**: short-term-detriment / long-term-detriment
- **Confidence**: 0-100
- **Location**: file:line
- **Description**: What is the problem
- **Evidence**: Why you believe this (reference knowledge-base entries)
- **Suggestion**: What should be done
```

---

## debate/SKILL.md Template

```
---
name: debate
description: >
  Resolves contradictions between review perspectives for {project_name}.
  Takes contradicting finding pairs and produces reasoned compromises.
---

# Debate: Contradiction Resolution

## Input

You receive pairs of contradicting findings from different perspectives.

## Process

For each contradiction pair:

1. Read both findings and their evidence
2. Check knowledge-base for relevant context that might resolve the contradiction
3. Determine which finding has stronger evidence
4. Produce a resolution:
   - If one is clearly correct: adopt it, explain why the other was wrong
   - If both have merit: produce a merged finding with combined evidence
   - If unresolvable: keep both, note the disagreement for human review

## Output Format

### Contradiction: [Finding A] vs [Finding B]
- **Resolution**: [merged finding / adopted A / adopted B / unresolved]
- **Reasoning**: [why this resolution was chosen]
- **Original findings preserved**: yes
```

---

## consolidation/SKILL.md Template

```
---
name: consolidation
description: >
  Produces the final review report for {project_name} by consolidating
  all perspective results and debate resolutions.
---

# Consolidation: Final Report Generation

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

## Report Format

# Review Report: [target name]

## Summary
- Review type, target, execution date
- Critical: N, Important: N, Suggestion: N

## Critical Findings
(never omit, show all)

## Important Findings
(summary + details)

## Suggestions
(list format)

## Debate Notes
(only if debate occurred)

## Knowledge Base References
(which knowledge-base entries were consulted)

## Health Score Data
(if available: relevant trends for reviewed areas)
```
