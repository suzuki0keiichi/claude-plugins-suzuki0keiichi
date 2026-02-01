# Project Management Skill

Manage complex, multi-step projects. Maintain focus on original objectives while adapting plans.

## When to Use

- Tasks with high uncertainty—where the solution path is unclear, multiple retries are expected, or progress tends to get lost without active tracking
- Bug investigation, performance debugging
- New library/API exploration (docs vs reality gaps)
- Environment setup issues
- Work requiring multiple approach attempts
- Tasks where you keep coming back to 'what was I doing?'
- `.claude/project-coordinator/` directory exists (ongoing project)

**NOT for:** Predictable, low-risk tasks that existing agents handle well.

## Core Principles

**AUTONOMOUS COORDINATOR:**
- **Purpose definition** → Collaborate with user if missing (only required interaction)
- **Planning & Execution** → Autonomous; no approval needed
- Primary responsibility: **Prevent getting lost** in uncertain work
- Only escalate when purpose is unclear or contradicted

## Documentation (`.claude/project-coordinator/`)

### 1. purpose.md - THE IMMUTABLE NORTH STAR

**Content:** Original objective, context, success criteria, scope
**⚠️ CRITICAL:** Updates ONLY when: User requests, assumptions invalidated, or technically impossible. NEVER update for implementation difficulties → adjust plan.md instead.

### 2. plan.md - Project Plan & Roadmap

**Content:** Progress %, steps with criteria, dependencies, risks, Plan B, completed log
**Update:** After steps complete, obstacles arise, or new info changes feasibility
**Revise:** Step fails, better path found, constraints change

### 3. work_summary.md / work_log_XX.md (Managed by Investigator)

**Owner:** `investigator` agent manages these files
**This skill's role:** Read work_summary.md for status. Refer to work_log_XX.md for details if needed.

## When Invoked

### 1. Initialize

1. Check `.claude/project-coordinator/` for existing docs
2. **purpose.md first**: Read existing. If missing or unclear, read `purpose-extraction.md` skill and apply it to clarify with user.
3. Create plan.md autonomously

### 2. Execute and Track

1. Execute steps, update plan.md at checkpoints
2. **Investigation tasks:** Use Task tool (see Agent Collaboration). One step per call, wait for return.
   - If investigator returns with 5 "NO": Revise plan or consult user
3. **At breakpoints:** Read `${CLAUDE_PLUGIN_ROOT}/resources/best-practices.md`
4. When stuck: Review all docs, re-evaluate vs purpose.md

### 3. Revise Plan

**Plans are flexible. Purpose is NOT.**

1. State revision trigger
2. Does this require changing purpose.md?
   - NO → Update plan.md
   - YES → **STOP** - Consult user (scope change)

**⚠️ Execution difficulty ≠ reason to change purpose.md.**

### 4. Complete Project

1. Verify ALL purpose.md success criteria satisfied
2. Ask user: "Create an archive summary before clearing?"
3. If yes: Create `archives/[topic]_[YYYYMMDD].md` using `${CLAUDE_PLUGIN_ROOT}/resources/archive-template.md`
4. Clear purpose.md, plan.md, work_summary.md, work_log_*.md

**⚠️ NEVER clear files without user confirmation.**

## Todo vs plan.md

- **TodoWrite**: For predictable tasks. Use when sufficient.
- **plan.md**: For uncertain work requiring frequent revision.
- Independent; no sync needed.

## Agent Collaboration

**Orchestration role. Delegate to investigator via Task tool when investigation needed.**

See `${CLAUDE_PLUGIN_ROOT}/resources/agent-collaboration.md` for details.

### Calling investigator (MUST use Task tool)

**investigator** - Unknown cause, multiple hypotheses, systematic elimination:
```
Task tool:
  subagent_type: "project-coordinator:investigator"
  prompt: "## Context\n[Purpose summary]\n\n## Step\n[Current step]\n\n## Task\n[Investigation details]"
```

**⚠️ CRITICAL:** Never just mention "delegate to investigator". Always use Task tool explicitly.

## Exit Conditions

**End this skill's application when:**
1. Plan completed (all steps done)
2. Purpose needs revision (consult user first)
3. Repeatedly stuck despite plan revisions

Next project will start fresh.

## Key Practices

- **Communication:** Regular updates, transparent on challenges
- **Quality:** Trace to purpose.md, document failures, clear success criteria
- **Escalate:** Assumptions invalidated, Plan B failed, scope exceeded, cycling, stalled
- **⚠️ CRITICAL:** NEVER run multiple file operations in parallel
