# Orchestrator Template

Fill in {placeholders} with project-specific content from knowledge-base.

```
---
name: review-orchestrator
description: >
  Orchestrates {project_name} review execution. Coordinates parallel review
  agents, fact-checking, design critique, and consolidation.
---

# {project_name} Review Orchestrator

## Step 0: Environment Setup (MUST do first)

1. Read `config.md` for project information
2. **All code lives in `workspace/`** — all git/code operations target `workspace/`, NOT the current directory
3. Read `knowledge-base/project-context.md` for project background

## Step 1: Perspective Selection

**ALWAYS use ALL perspectives. Do NOT exclude any.**

Every perspective exists for a reason. "This PR doesn't seem related to X" is exactly the kind of assumption that causes blind spots. The ONLY exception: user explicitly asks to exclude specific perspectives.

## Input Analysis

If no review target is specified, ask the user:
1. PR Review — specify PR number or branch
2. Code Health Review — specify module/directory
3. Design Review — provide design document
4. Incident Review — provide incident info

## Execution

### Phase 1: Parallel Independent Review

**Use the Agent tool** to launch each perspective as a separate subagent. Do NOT execute perspectives yourself — context pollution degrades quality.

Launch ALL perspectives in parallel:
{for each perspective}
- Agent tool: name="{perspective_name}", prompt="Read .claude/skills/{perspective_id}/SKILL.md and execute against [review target]. Return findings in the output format specified."
{end for}

**Save raw outputs**: Write each perspective's full output to `reviews/perspectives/{YYYY-MM-DD}-{target}/{perspective_name}.md`.

### Phase 1.5: Fact Check

Read `.claude/skills/fact-check/SKILL.md` and follow its instructions against all Phase 1 findings.

### Phase 1.7: Design Critique (PR Reviews and Design Reviews)

Read `.claude/skills/design-critique/SKILL.md` and follow its instructions.

### Phase 2: Contradiction Detection

Scan all findings for contradictions (same location different severity, conflicting suggestions, duplicates). If found: **use the Agent tool** to launch debate. If none: skip to Phase 3.

### Phase 3: Consolidation

**Use the Agent tool** to launch consolidation as a separate subagent.

Agent tool: name="consolidation", prompt="Read .claude/skills/consolidation/SKILL.md and follow its instructions. Input: [all Phase 1 results + debate results]. MUST write reports to reviews/."

**MANDATORY**: Two review files MUST exist after consolidation:
- `reviews/{YYYY-MM-DD}-{type}-{target}-short-term.md`
- `reviews/{YYYY-MM-DD}-{type}-{target}-long-term.md`
```
