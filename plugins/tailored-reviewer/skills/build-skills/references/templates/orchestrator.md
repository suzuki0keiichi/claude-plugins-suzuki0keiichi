# Orchestrator Template

Fill in {placeholders} with project-specific content from knowledge-base.

```
---
name: review-{project_name_slug}
description: >
  This skill should be used when the user asks to "review", "review PR",
  "review code", "run review", "レビュー", "レビューして", "PRレビュー",
  "コードレビュー", or wants to execute the {project_name} review system
  against a PR, module, or incident.
argument-hint: [PR #123 | module src/ | incident description]
---

# {project_name} Review

## Step 0: Environment Setup (MUST do first)

The current directory is the **review data project**. This directory contains:
- `config.md` — project configuration (read this for git URL and project info)
- `knowledge-base/` — collected project knowledge
- `meta/` — metadata files
- `workspace/` — git clone of the actual project
- `.claude/skills/` — generated review skills
- `reviews/` — review output destination

**IMPORTANT:**
- The project root is NOT a git repository. `workspace/` is.
- All git commands (`gh`, `git`) must run inside `workspace/`.
- All code reading must target `workspace/`.
- Review outputs go to `reviews/` at the project root.

1. Read `config.md` for project information
2. Read `knowledge-base/project-context.md` for project background

## Step 0.5: Output Language Detection

Detect the language of the user's review instruction (e.g., "レビューして" → Japanese, "review PR #123" → English). Store this as `{output_language}` — it will be passed to the consolidation agent so the final report is written in the same language the user used.

## Step 0.6: Input Data Preparation (MUST do before launching agents)

Background subagents cannot run interactive Bash commands (permission approval is blocked). ALL external data must be fetched here by the orchestrator and saved to files.

**For PR reviews:**
1. Create the output directory: `reviews/perspectives/{YYYY-MM-DD}-{target}/`
2. Run these commands in `workspace/`:
   - `cd workspace && gh pr diff {number} > ../reviews/perspectives/{YYYY-MM-DD}-{target}/pr-diff.txt`
   - `cd workspace && gh pr view {number} > ../reviews/perspectives/{YYYY-MM-DD}-{target}/pr-info.txt`
   - `cd workspace && gh pr view {number} --json files --jq '.files[].path' > ../reviews/perspectives/{YYYY-MM-DD}-{target}/pr-files.txt`
3. Verify the files are non-empty. If `gh` fails, ask the user to check authentication.

**For non-PR reviews:** Skip this step. Agents can Read code files directly.

## Step 0.7: Spec Context Collection

Collect specification and design context relevant to this review. This data is used by Phase 1.7 (Design Critique) for spec conformance checking, and by individual perspectives for Fact Check verification.

1. **Auto-fetch linked ticket** (PR reviews only):
   - Parse the PR description and branch name for ticket references (e.g., `PROJ-123`, `#456`)
   - If a ticket reference is found AND an MCP tool can access that tracker → fetch the ticket description and acceptance criteria
   - Save to `reviews/perspectives/{YYYY-MM-DD}-{target}/spec-context.md`

2. **Ask the user**:
   Use AskUserQuestion:
   "Are there any specifications, design documents, or discussion threads related to this PR?
   Provide URLs, ticket numbers, document names, or describe where to find them.
   If none, just say 'none'."

3. **Fetch provided sources**:
   For each source the user provides:
   - If a URL is given → check if its domain matches an available MCP tool (e.g., `*.atlassian.net` → Atlassian MCP, `*.slack.com` → Slack MCP). If a matching MCP tool exists, use it for richer data. Otherwise, use WebFetch.
   - If a document name or search term is given → use available MCP tools to search, or ask the user for a more specific location
   - If user says "find it" or "search for it" → use available MCP tools and WebSearch to locate relevant specs

4. **Save results**:
   - Append all fetched content to `reviews/perspectives/{YYYY-MM-DD}-{target}/spec-context.md`
   - If nothing was found (user said "none" and no linked ticket), create the file with content: `No spec context available for this review.`

**IMPORTANT**: This step runs in the orchestrator (not in a subagent) because it may require AskUserQuestion and MCP tool access that subagents cannot use interactively.

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

**IMPORTANT**: Subagents run in the background and CANNOT execute Bash commands interactively. All data they need must be accessible via the Read tool.

Launch ALL perspectives in parallel:
{for each perspective}
- Agent tool: name="{perspective_name}", prompt="Read .claude/skills/{perspective_id}/SKILL.md and execute against [review target]. All code is in workspace/. For PR reviews: the PR diff is at reviews/perspectives/{YYYY-MM-DD}-{target}/pr-diff.txt, PR description at pr-info.txt, changed files list at pr-files.txt — use the Read tool to access these files. Do NOT run gh or git commands. Output language: {output_language}. Return findings in the output format specified."
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

Agent tool: name="consolidation", prompt="Read .claude/skills/consolidation/SKILL.md and follow its instructions. Input: [all Phase 1 results + debate results]. Output language: {output_language}. MUST write reports to reviews/."

**MANDATORY**: Two review files MUST exist after consolidation:
- `reviews/{YYYY-MM-DD}-{type}-{target}-short-term.md`
- `reviews/{YYYY-MM-DD}-{type}-{target}-long-term.md`
```
