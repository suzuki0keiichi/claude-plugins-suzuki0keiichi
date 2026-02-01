# Project Management Skill

Manage complex multi-step tasks. Maintain focus on objectives while adapting plans.

## When to Use

- Tasks with 3+ steps
- High uncertainty work (unclear solution, multiple retries expected)
- Work where progress tends to get lost
- `.claude/project-coordinator/` directory exists (ongoing project)

## Core Principles

**Execute autonomously. But guard the purpose.**

- Purpose definition → Collaborate with user (required interaction)
- Planning & execution → Autonomous
- **User reporting** → Report at each step completion, on obstacles
- Escalation → Only when purpose is unclear or contradicted

## Document Management (`.claude/project-coordinator/`)

### 1. purpose.md - The Immutable North Star

**Content:** Original objective, context, success criteria, scope

**⚠️ CRITICAL:** Update ONLY when:
- User requests
- Assumptions invalidated
- Technically impossible

**Implementation difficulty ≠ reason to change purpose** → Adjust plan.md instead

### 2. plan.md - Project Plan

**Content:** Progress %, steps with criteria, dependencies, risks, Plan B, completed log

**Update when:**
- Step completed
- Obstacle encountered
- New info changes feasibility

### 3. work_summary.md / work_log_XX.md (investigator managed)

**Owner:** investigator agent

**This skill's role:** Read work_summary.md for status. Refer to work_log_XX.md for details.

## Execution Flow

### 1. Initialize

1. Check `.claude/project-coordinator/` for existing docs
2. **purpose.md first:**
   - Exists and clear → Proceed to plan.md
   - Missing or unclear → Read `purpose-extraction.md` skill and apply it
3. Create plan.md autonomously
4. **Report plan to user**

### 2. Execute and Track

1. Execute steps, update plan.md at checkpoints
2. **Investigation tasks:** Delegate to investigator (see below)
   - If investigator returns with 5 "NO": Revise plan or consult user
3. **On each step completion:** Report progress to user
4. When stuck: Review all docs, re-evaluate against purpose.md

### 3. Revise Plan

**Plans are flexible. Purpose is NOT.**

1. State revision trigger
2. Does this require changing purpose.md?
   - NO → Update plan.md
   - YES → **STOP** - Consult user (scope change)
3. **Report plan revision to user**

### 4. Complete Project

1. Verify ALL purpose.md success criteria satisfied
2. Ask user: "Create an archive summary before clearing?"
3. If yes: Create `archives/[topic]_[YYYYMMDD].md`
4. Clear purpose.md, plan.md, work_summary.md, work_log_*.md

**⚠️ NEVER clear files without user confirmation**

## Agent Delegation

Use Task tool to delegate to specialist agents.

### investigator - When investigation needed

Use when: Unknown cause, multiple hypotheses, systematic elimination required.

```
Task tool:
  subagent_type: "project-coordinator:investigator"
  prompt: |
    ## Context
    [Summary of purpose]

    ## Current Step
    [Relevant step from plan.md]

    ## Task
    [Investigation details]
```

**⚠️ CRITICAL:** "Delegate to X" means "Use Task tool". Never skip the Task tool call.

## User Reporting (Critical)

**Core value of this skill: visibility.**

Report to user at these timings:

| Timing | Content |
|--------|---------|
| After planning | Plan overview, step count, expected risks |
| After each step | What completed, next step, progress % |
| On obstacle | What happened, how to handle |
| On plan revision | Reason, what changed |
| On investigator delegation | What's being investigated |
| On project completion | Summary of outcomes |

## TodoWrite vs plan.md

- **TodoWrite**: For predictable tasks
- **plan.md**: For uncertain work requiring frequent revision
- Independent; no sync needed

## Exit Conditions

End this skill's application when:

1. Plan completed (all steps done)
2. Purpose needs revision (after user consultation)
3. Stuck despite repeated plan revisions
