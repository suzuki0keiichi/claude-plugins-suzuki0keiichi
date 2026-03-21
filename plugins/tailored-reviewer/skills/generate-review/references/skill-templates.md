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

## Step 0: Environment Setup (MUST do first)

1. Read `config.md` to get project information
2. **All code lives in `workspace/`** — this is a git clone of the project. All git operations and code reading MUST target `workspace/`, NOT the current directory root
3. Read `knowledge-base/project-context.md` for project background

**IMPORTANT**: The current directory is the review data repository, NOT the project itself. Never run git commands on the current directory root.

## Step 1: Perspective Selection

Count the total number of available perspectives (technical concerns + domain perspectives).

**If 7 or fewer**: Skip selection, use all perspectives.

**If 8 or more**: Present selection UI using AskUserQuestion:

Available perspectives (select by number, preset, or "all"):

Technical:
  1. execution-flow — {one-line description with project tech stack}
  2. resource-management — ...
  3. concurrency — ...
  4. security — ...
  5. platform-constraints — ...
  6. implementation-quality — ...

Domain:
  7. {domain-perspective-1} — ...
  ...

Presets:
  [P] PR Review: {preset_pr_perspectives}
  [F] Full: all
  [Q] Quick: security, implementation-quality

Selection:

Wait for user response. Parse selected perspective IDs.

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

Dispatch each perspective as an Agent:
{for each perspective}
- Agent: "{perspective_name}" — Read .claude/skills/{perspective_id}/SKILL.md and execute
{end for}

Collect all agent results. Each returns findings in unified format.

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

3. **Design Alternative Analysis**: Is this the right approach?
   - Are there simpler solutions that achieve the same goal?
   - Does this approach create new maintenance burden?
   - Does it solve the symptom or the root cause?

4. **Coverage Assessment**: What edge cases aren't handled?
   - What happens with unexpected input?
   - What happens under failure conditions?
   - What happens when upstream/downstream systems change?

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

## Technical Concern SKILL.md Template

Use this for the 6 technical concern perspectives (execution-flow, resource-management,
concurrency, security, platform-constraints, implementation-quality).

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
{same as domain template}

## Output Format
{same as domain template}
```

---

## Domain SKILL.md Template

Use this for project-specific domain perspectives (e.g., community-isolation,
api-cost-defense). Only generated when knowledge-base reveals domain-specific
rules that don't map to the 6 technical concerns.

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

## Process

1. Merge all findings, replacing contradicted findings with debate resolutions
2. Filter: exclude findings with Confidence < 80 from the report
3. Count ALL Suggestion-level findings (pre-filter) for health score tracking
4. Sort by severity (Critical → Important → Suggestion)
5. Deduplicate remaining overlaps
6. Generate report
7. **Write report to the file path determined above** — confirm the file was written by reading it back

## Report Format

# Review Report: [target name]

## Summary
- Review type, target, execution date
- Short-term detriments: Critical N, Important N, Suggestion N
- Long-term detriments: Critical N, Important N, Suggestion N
- Design critique findings: N
- Findings dropped by fact-check: N
- Findings dropped by workspace reconciliation: N (PR reviews only)

## Short-term Detriments (bugs, security, performance, cost)

### Critical
(each finding in structured format with Verification field. Never omit.)

### Important
(structured format)

### Suggestions
(list format)

## Long-term Detriments (tech debt, design drift, chaos)

### Critical
(structured format)

### Important
(structured format)

### Suggestions
(list format)

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
