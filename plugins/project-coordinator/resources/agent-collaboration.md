# Agent Collaboration Guide

## Overview

```
┌─────────────────────────────────────────────────────────────┐
│          Main Agent + project-management skill              │
│                   (Orchestrator / Hub)                      │
│                                                             │
│  Manages: purpose.md, plan.md                               │
│  Role: Overall coordination, progress tracking, archiving   │
│  Reports: Directly to user (visibility)                     │
└──────────────────────┬──────────────────────────────────────┘
                       │
         ┌─────────────┴─────────────┐
         │                           │
         ▼                           ▼
┌─────────────────┐         ┌─────────────────┐
│purpose-extractor│         │   investigator  │
│                 │         │                 │
│ When: Purpose   │         │ When: Unknown   │
│ is missing or   │         │ cause, complex  │
│ unclear         │         │ investigation   │
│                 │         │                 │
│ Writes:         │         │ Manages:        │
│ purpose.md      │         │ work_summary.md │
└─────────────────┘         └─────────────────┘
```

## Why This Architecture

### Main Agent as Orchestrator (with Skill)

- **User visibility**: Main agent reports directly to user
- **Compaction resilience**: Rules trigger skill reload after compaction
- **Stable orchestration**: Avoids "waiting" issues of sub-agent orchestrators

### Specialists as Agents

- **Context separation**: Investigation consumes large context; keep it isolated
- **Single-task fit**: "Investigate and return" matches sub-agent pattern well

## Collaboration Flows

### Flow 1: Standard Project

```
User Request
    │
    ▼
Main Agent (reads project-management skill)
    │
    ├─ purpose.md exists & clear? ─── YES ──→ Create/update plan.md
    │                                              │
    NO                                             ▼
    │                                         Execute plan
    ▼                                              │
purpose-extractor                                  ▼
    │                                    Report progress to user
    ├─ Clarify with user                           │
    │                                              ▼
    ▼                                         Complete
Write purpose.md                                   │
    │                                              ▼
    ▼                                    Main Agent (Archive)
Return to Main Agent
```

### Flow 2: Investigation Task

```
User: "Tests fail randomly in CI"
    │
    ▼
Main Agent (with skill)
    │
    ├─ Create plan with steps
    ├─ Report plan to user
    │
    ▼
Delegate step 1 to investigator (fresh session)
    │
    ▼
investigator
    │
    ├─ Execute ONE step only
    ├─ Log trials in work_log_XX.md
    ├─ Return when: step done OR 5 "NO"
    │
    ▼
Return to Main Agent
    │
    ├─ Read work_summary.md
    ├─ Report progress to user
    ├─ Decide: continue / revise plan / consult user
    │
    ▼
Delegate step 2 to investigator (NEW fresh session)
    │
    ... (repeat per step)
    │
    ▼
All steps complete
    │
    ▼
Main Agent: report completion, archive if requested
```

### Flow 3: Plan Without Purpose

```
User provides plan (or uses Plan Mode)
    │
    ▼
Main Agent (with skill)
    │
    ├─ purpose.md missing or plan-purpose mismatch?
    │
    YES
    │
    ▼
purpose-extractor
    │
    ├─ Reverse-engineer purpose from plan
    ├─ Detect misalignments
    ├─ Clarify with user (AskUserQuestion)
    │
    ▼
Write purpose.md
    │
    ▼
Return to Main Agent
    │
    ▼
Proceed with execution, report to user
```

## When to Call Each Agent

### Main Agent calls purpose-extractor when:

| Situation | Trigger |
|-----------|---------|
| No purpose.md | Project init without clear objective |
| Plan-purpose mismatch | Plan steps don't align with stated goal |
| Vague objective | "Improve X" without specifics |
| Multiple objectives | Need to split or clarify scope |
| Plan Mode output | External plan needs purpose grounding |

### Main Agent calls investigator when:

| Situation | Trigger |
|-----------|---------|
| Unknown cause | Bug with unclear root cause |
| Multiple possibilities | Need systematic elimination |
| Intermittent issues | Hard to reproduce problems |
| Performance mysteries | Unclear bottleneck |
| Complex debugging | Multi-component investigation |

### investigator returns to Main Agent when:

| Condition | Action |
|-----------|--------|
| Step completed | Update work_summary.md, return |
| 5 "NO" in trials | Update work_summary.md, return for plan revision |
| All hypotheses eliminated | Document in work_summary.md, return |
| Plan direction needs change | Return with recommendation |
| Limit reached | Document state, return for decision |

### purpose-extractor returns to Main Agent when:

| Event | Deliverable |
|-------|-------------|
| Purpose clarified | Updated purpose.md |
| Scope defined | Success criteria documented |
| Misalignment resolved | Plan-purpose now aligned |

## Data Ownership

| File | Owner | Others |
|------|-------|--------|
| purpose.md | purpose-extractor (creates), Main Agent (guards) | Read-only |
| plan.md | Main Agent (with skill) | Read-only |
| work_summary.md | investigator | Main Agent reads for status |
| work_log_XX.md | investigator | Main Agent reads if details needed |
| archives/ | Main Agent | Read-only |

## Communication Protocol

### From Specialist → Main Agent

```markdown
## [Agent] Update

**Status:** [Working/Blocked/Complete]
**Summary:** [1-2 sentences]

**Deliverable:** [What was produced]
**Next:** [Recommendation for Main Agent]
```

### From Main Agent → Specialist

**Use Task tool to call specialists.** Context is passed via prompt parameter:

```markdown
## Calling investigator
Task tool:
  subagent_type: "project-coordinator:investigator"
  prompt: |
    ## Context
    [Summary of purpose.md]

    ## Current Step
    [Relevant step from plan.md]

    ## Task
    [Specific investigation instructions]

    ## Expected Deliverable
    [What you expect back]

## Calling purpose-extractor
Task tool:
  subagent_type: "project-coordinator:purpose-extractor"
  prompt: |
    ## User Request
    [Original user request]

    ## Background
    [Any relevant context]
```

**⚠️ CRITICAL:** "Delegate to X" means "Use Task tool with subagent_type". Never skip the Task tool call.

## User Reporting (Key Responsibility)

Main Agent must report to user at these points:

| Timing | Content |
|--------|---------|
| After planning | Plan overview, steps, risks |
| After each step | What completed, next step, progress % |
| On obstacles | What happened, how to handle |
| On plan revision | Why, what changed |
| On delegation | What's being investigated |
| On completion | Summary of outcomes |
