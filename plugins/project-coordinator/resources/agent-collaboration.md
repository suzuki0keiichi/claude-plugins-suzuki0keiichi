# Agent Collaboration Guide

## Overview

```
┌─────────────────────────────────────────────────────────────┐
│   Main Agent + project-management & purpose-extraction      │
│                      (Orchestrator)                         │
│                                                             │
│  Skills: project-management.md, purpose-extraction.md       │
│  Manages: purpose.md, plan.md                               │
│  Reports: Directly to user (visibility)                     │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
              ┌─────────────────┐
              │   investigator  │
              │                 │
              │ When: Unknown   │
              │ cause, complex  │
              │ investigation   │
              │                 │
              │ Manages:        │
              │ work_summary.md │
              └─────────────────┘
```

## Why This Architecture

### Main Agent as Orchestrator (with Skills)

- **User visibility**: Main agent reports directly to user
- **Compaction resilience**: Rules trigger skill reload after compaction
- **Stable orchestration**: Avoids "waiting" issues of sub-agent orchestrators
- **Interactive tasks**: Purpose extraction requires frequent user dialogue

### investigator as Agent

- **Context separation**: Investigation consumes large context; keep it isolated
- **Single-task fit**: "Investigate and return" matches sub-agent pattern well
- **Deep focus**: Needs to "dig" without distraction

## Collaboration Flow

### Standard Project Flow

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
Read purpose-extraction skill                      ▼
    │                                    Report progress to user
    ├─ Clarify with user (direct dialogue)         │
    │                                              ▼
    ▼                                         Complete
Write purpose.md                                   │
    │                                              ▼
    ▼                                    Main Agent (Archive)
Continue with plan
```

### Investigation Flow

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

## When to Use Each Component

### Main Agent applies purpose-extraction skill when:

| Situation | Trigger |
|-----------|---------|
| No purpose.md | Project init without clear objective |
| Plan-purpose mismatch | Plan steps don't align with stated goal |
| Vague objective | "Improve X" without specifics |
| Multiple objectives | Need to split or clarify scope |

### Main Agent delegates to investigator when:

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

## Data Ownership

| File | Owner | Others |
|------|-------|--------|
| purpose.md | Main Agent (with skill) | Read-only |
| plan.md | Main Agent (with skill) | Read-only |
| work_summary.md | investigator | Main Agent reads for status |
| work_log_XX.md | investigator | Main Agent reads if details needed |
| archives/ | Main Agent | Read-only |

## Communication Protocol

### From investigator → Main Agent

```markdown
## investigator Update

**Status:** [Working/Blocked/Complete]
**Summary:** [1-2 sentences]

**Deliverable:** [What was produced]
**Next:** [Recommendation for Main Agent]
```

### From Main Agent → investigator

Use Task tool to delegate:

```markdown
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
```

**⚠️ CRITICAL:** "Delegate to investigator" means "Use Task tool". Never skip the Task tool call.

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
