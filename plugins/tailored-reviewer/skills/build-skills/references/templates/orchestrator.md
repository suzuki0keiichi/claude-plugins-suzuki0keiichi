# Orchestrator Template

Fill in {placeholders} with project-specific content from knowledge-base.

```
---
name: review-orchestrator
description: >
  Orchestrates {project_name} review execution. Determines review type,
  selects perspectives, coordinates parallel review agents, detects
  contradictions, and produces the final review report.
---

# {project_name} Review Orchestrator

## Step 0: Environment Setup (MUST do first)

1. Read `config.md` to get project information
2. **All code lives in `workspace/`** — this is a git clone of the project. All git operations and code reading MUST target `workspace/`, NOT the current directory root
3. Read `knowledge-base/project-context.md` for project background

**IMPORTANT**: The current directory is the review data repository, NOT the project itself. Never run git commands on the current directory root.

## Step 1: Perspective Selection

**ALWAYS use ALL perspectives. Do NOT exclude any.**

You are not authorized to decide which perspectives are relevant. Every perspective exists for a reason, and "this PR doesn't seem related to X" is exactly the kind of assumption that causes blind spots. code-health and strategic-alignment are ESPECIALLY important — they evaluate design quality and project direction, which applies to EVERY PR regardless of its apparent scope.

The ONLY exception: if the user explicitly asks to exclude specific perspectives (e.g., for token budget), follow their instruction. Never exclude on your own judgment.

## Input Analysis

If no review target is specified, ask the user:
1. PR Review — specify PR number or branch (git operations in `workspace/`)
2. Code Health Review — specify module/directory (relative to `workspace/`)
3. Design Review — provide design document
4. Incident Review — provide incident info

Determine review type from input:

| Input | Type | Perspectives to Activate |
|-------|------|-------------------------|
| PR diff + description | PR Review | {pr_perspectives} |
| Design document | Design Review | {design_perspectives} |
| Module/area name | Code Health Review | {health_perspectives} |
| Incident info + code | Incident Review | {incident_perspectives} |

## Execution

### Phase 1: Parallel Independent Review

**Use the Agent tool** to launch each perspective as a separate subagent. Do NOT execute perspectives yourself — each perspective must run in its own Agent to avoid context pollution. Running all perspectives in the orchestrator's context will exceed context limits and degrade quality.

Launch all perspectives in parallel using the Agent tool:
{for each perspective}
- Agent tool: name="{perspective_name}", prompt="Read .claude/skills/{perspective_id}/SKILL.md and execute it against [review target]. Return findings in the output format specified in the skill."
{end for}

Collect all agent results. Each returns findings in unified format.

**Save raw perspective outputs**: Write each perspective's full output to `reviews/perspectives/{YYYY-MM-DD}-{target}/{perspective_name}.md`. This preserves the detailed analysis before consolidation compresses it. Create the directory if it does not exist.

### Phase 1.5: Cross-Perspective Fact Check

Before contradiction detection, verify ALL findings against actual code.

#### Step A: Workspace Verification (ALL findings)

For EVERY finding with Severity Critical or Important:
1. Re-read the cited code location in `workspace/`
2. Confirm the finding's Verification field matches the actual code
3. If the code does not match the finding: **drop the finding**
4. If mitigating code exists elsewhere: downgrade Severity or drop

#### Step B: PR Diff vs Workspace Reconciliation (PR Reviews ONLY — skip in backtest)

**Skip this step entirely if running in backtest mode.** In backtest mode, the workspace is intentionally set to the bug-introducing commit state, and reconciliation against the default branch would falsely drop all findings.

**CRITICAL for normal PR reviews**: The PR diff shows the state at PR creation time. The workspace may contain the post-merge state with subsequent fixes. For each finding based on the PR diff:

1. Read the CURRENT version of the cited file in `workspace/`
2. Compare the specific lines cited in the finding against the current workspace code
3. If the issue described in the finding is **already fixed** in the workspace version:
   - **Drop the finding entirely** — do not report fixed issues
4. If the issue is **partially fixed** in the workspace:
   - Update the finding to reflect only the remaining issue
   - Note: "Partially addressed in merged version"
5. If the issue **still exists** in the workspace:
   - Keep the finding as-is

**Every PR review finding MUST survive this reconciliation step. Findings that cite code no longer present in workspace are false positives and damage review credibility.**

#### Step C: Cross-Source Validation

Findings detected by only ONE perspective (single-source) have higher false-positive risk:
- Apply extra scrutiny: actively search for guards, checks, or handling elsewhere
- Multi-source findings have implicit cross-validation and can skip this step

### Phase 1.7: Design Critique (PR Reviews and Design Reviews)

After fact-checking individual findings, step back and evaluate the change holistically:

1. **Purpose vs Implementation Gap**: Read the PR description/commit message. Does the implementation actually achieve the stated goal? Are there gaps between what was promised and what was delivered?

2. **Omission Detection**: What SHOULD have been changed but wasn't?
   - If a new wrapper/abstraction was introduced, does ALL existing code use it? (e.g., gh.sh wrapper introduced but other scripts still call gh directly)
   - If a security boundary was established, is it comprehensive?
   - Are there related files that need corresponding changes?
   - **Deleted code feature coverage**: if the PR deletes files or code blocks, list each feature/behavior the deleted code provided. Then verify each feature is covered by the new code. Missing features are UX regression candidates. Pay special attention to user-facing notifications, warning messages, grace periods, and fallback behaviors — these "soft" features are most often lost in rewrites.

3. **Design Alternative Analysis**: Is this the right approach?
   - Are there simpler solutions that achieve the same goal?
   - Does this approach create new maintenance burden?
   - Does it solve the symptom or the root cause?

4. **Coverage Assessment**: What edge cases aren't handled?
   - What happens with unexpected input?
   - What happens under failure conditions?
   - What happens when upstream/downstream systems change?

5. **Structural Root Cause**: If Phase 1 found Critical/Important bugs, ask: why was this bug structurally possible? Look beyond the diff — the code AROUND the bug (existing naming, types, API design) may be the real problem. Check bug-patterns.md: if this area is a known hotspot, explain WHY it keeps producing bugs, not just THAT it does. This turns a short-term bug finding into a long-term design improvement recommendation.

Output format for design critique findings:
- **Severity**: Important (design issues are rarely Critical unless security-related)
- **Category**: design-critique
- **Confidence**: 70-90 (design judgments inherently have more uncertainty)
- **Description**: What the design gap is
- **Alternative**: What a better approach might look like
- **Evidence**: Why you believe this matters (reference knowledge-base, similar bugs, design principles)

### Phase 2: Contradiction Detection

Scan all findings for:
- Same location, different severity → contradiction
- Conflicting suggestions for same issue → contradiction
- Duplicate findings across perspectives → merge candidates

If contradictions found: **use the Agent tool** to launch the debate agent. Agent tool: name="debate", prompt="Read .claude/skills/debate/SKILL.md and resolve these contradictions: [contradiction pairs]"
If no contradictions: skip to Phase 3.

### Phase 3: Consolidation

**Use the Agent tool** to launch consolidation as a separate subagent. Do NOT consolidate results yourself — running consolidation inline pollutes the orchestrator's context and risks losing findings.

Agent tool: name="consolidation", prompt="Read .claude/skills/consolidation/SKILL.md and follow its instructions. Input: [all Phase 1 results + debate results]. The skill contains MANDATORY file output instructions — you MUST write the report to reviews/."

Input to consolidation:
- All Phase 1 results (preserved separately)
- Debate results (if any)
- Health score data (if available at health/scores/)

**MANDATORY**: The final review report MUST be written to `reviews/{YYYY-MM-DD}-{type}-{target}.md`. If this file does not exist after consolidation, the review is incomplete.
```
