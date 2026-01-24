# Agent Collaboration Guide

## Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    project-coordinator                       │
│                   (Orchestrator / Hub)                       │
│                                                             │
│  Manages: purpose.md, plan.md                               │
│  Role: Overall coordination, progress tracking, archiving   │
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

## Collaboration Flows

### Flow 1: Standard Project

```
User Request
    │
    ▼
project-coordinator
    │
    ├─ purpose.md exists & clear? ─── YES ──→ Create/update plan.md
    │                                              │
    NO                                             ▼
    │                                         Execute plan
    ▼                                              │
purpose-extractor                                  ▼
    │                                         Complete
    ├─ Clarify with user                           │
    │                                              ▼
    ▼                                    project-coordinator
Write purpose.md                              (Archive)
    │
    ▼
Return to project-coordinator
```

### Flow 2: Investigation Task

```
User: "Tests fail randomly in CI"
    │
    ▼
project-coordinator
    │
    ├─ Create plan with steps
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
Return to project-coordinator
    │
    ├─ Read work_summary.md
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
project-coordinator: archive and return
```

### Flow 3: Plan Without Purpose

```
User provides plan (or uses Plan Mode)
    │
    ▼
project-coordinator
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
Return to project-coordinator
    │
    ▼
Proceed with execution
```

## When to Call Each Agent

### project-coordinator calls purpose-extractor when:

| Situation | Trigger |
|-----------|---------|
| No purpose.md | Project init without clear objective |
| Plan-purpose mismatch | Plan steps don't align with stated goal |
| Vague objective | "Improve X" without specifics |
| Multiple objectives | Need to split or clarify scope |
| Plan Mode output | External plan needs purpose grounding |

### project-coordinator calls investigator when:

| Situation | Trigger |
|-----------|---------|
| Unknown cause | Bug with unclear root cause |
| Multiple possibilities | Need systematic elimination |
| Intermittent issues | Hard to reproduce problems |
| Performance mysteries | Unclear bottleneck |
| Complex debugging | Multi-component investigation |

### investigator reports to project-coordinator when:

| Event | Report Content |
|-------|----------------|
| Significant finding | New evidence, hypothesis update |
| Hypothesis eliminated | What was ruled out and why |
| Blocked | Need decision or additional info |
| Milestone | Major progress checkpoint |
| Complete | Root cause confirmed, summary |

### purpose-extractor returns to project-coordinator when:

| Event | Deliverable |
|-------|-------------|
| Purpose clarified | Updated purpose.md |
| Scope defined | Success criteria documented |
| Misalignment resolved | Plan-purpose now aligned |

## Data Ownership

| File | Owner | Others |
|------|-------|--------|
| purpose.md | purpose-extractor (creates), project-coordinator (guards) | Read-only |
| plan.md | project-coordinator | Read-only |
| work_summary.md | investigator | project-coordinator reads for status |
| work_log_XX.md | investigator | project-coordinator reads if details needed |
| archives/ | project-coordinator | Read-only |

## Communication Protocol

### From Specialist → Coordinator

```markdown
## [Agent] Update

**Status:** [Working/Blocked/Complete]
**Summary:** [1-2 sentences]

**Deliverable:** [What was produced]
**Next:** [Recommendation for coordinator]
```

### From Coordinator → Specialist

Context is passed via task description:
- Current purpose (from purpose.md)
- Relevant plan context
- Specific question or task
- Expected deliverable
