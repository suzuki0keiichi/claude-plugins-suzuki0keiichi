---
name: project-coordinator
description: This skill should be used when the user asks to "manage this complex task", "track this project", "coordinate this work", "I keep losing track", "investigate this bug", "このタスクを管理して", "進捗を追跡して", "迷子になってきた", "このバグを調査して", or mentions project coordination, purpose tracking, or plan management. Provides orchestration for complex, uncertain tasks while maintaining focus on original objectives.
---

# Project Coordinator Skill

Launch project coordination for complex, uncertain tasks.

## When to Use

- Tasks with high uncertainty—where the solution path is unclear, multiple retries are expected, or progress tends to get lost without active tracking
- Bug investigation, performance debugging
- New library/API exploration (docs vs reality gaps)
- Environment setup issues
- Work requiring multiple approach attempts
- Tasks where you keep coming back to 'what was I doing?'
- `.claude/project-coordinator/` directory exists (ongoing project)

**NOT for:** Predictable, low-risk tasks that existing agents handle well.

## When Invoked

1. Check `.claude/project-coordinator/` for existing docs
2. **purpose.md first**: Read existing. If missing or unclear, read `purpose-extraction` skill and apply it to clarify with user.

### Agent Teams mode (when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is available)

Execute the following steps **exactly in order**. Do not skip, reorder, or improvise.

**⚠️ Critical rules — violating ANY of these breaks the workflow:**
- coordinator gets **ONE task**: the full project objective
- investigator gets **ZERO tasks** from the lead
- The lead **MUST NOT** split work into subtasks — coordinator handles all breakdown
- The lead **MUST NOT** assign tasks to investigator — coordinator does this via SendMessage

#### Step 1: TeamCreate

```
TeamCreate(
  team_name: "project-coordinator",
  description: "<1-line summary from purpose.md>"
)
```

#### Step 2: TaskCreate — ONE project task

Create exactly one task. This is the **entire project objective**, not a subtask.

```
TaskCreate(
  subject: "<user's task in imperative form>",
  description: "## Purpose\n<purpose.md content>\n\n## Task\n<user's original request>",
  activeForm: "<present continuous form of the task>"
)
```

Record the returned **task ID** for Step 4.

#### Step 3: Spawn teammates — two Task calls in a single message (parallel)

```
Task(
  subagent_type: "project-coordinator:coordinator",
  name: "coordinator",
  team_name: "project-coordinator",
  description: "Coordinate project investigation",
  prompt: "You are the coordinator for this team.\nYour teammate is \"investigator\" — send investigation tasks via SendMessage.\nCheck TaskList, claim your task, read purpose.md, create plan.md, then begin."
)

Task(
  subagent_type: "project-coordinator:investigator",
  name: "investigator",
  team_name: "project-coordinator",
  description: "Investigate on coordinator direction",
  prompt: "You are the investigator for this team.\nWait for coordinator to send you tasks via messages.\nDo NOT start working until coordinator gives you a specific task."
)
```

#### Step 4: TaskUpdate — assign to coordinator

```
TaskUpdate(
  taskId: <task ID from Step 2>,
  owner: "coordinator"
)
```

Do NOT set `status: "in_progress"` — coordinator does this when it claims the task.

#### Step 5: Lead is done

After Step 4, the lead's launch work is complete.

- **Coordinator** reads TaskList, claims the task, creates plan.md, delegates investigation steps to investigator via SendMessage
- **Investigator** waits idle until coordinator sends a message, then begins work
- **Coordinator** enters monitoring loop (Sleep → check-in → evaluate → act)
- **Coordinator** messages the lead when: step complete, plan revision needed, or 5 "NO" threshold hit

The lead should **wait for coordinator's reports**. Do not poll or micromanage.
User can message either teammate directly (Shift+Up/Down in terminal).

### Subagent mode (when Agent Teams is not available)

Read `${CLAUDE_PLUGIN_ROOT}/agents/coordinator.md` and apply its principles in this session.

For investigation tasks, call investigator via Task tool:
```
Task tool:
  subagent_type: "project-coordinator:investigator"
  prompt: "## Context\n[Purpose summary]\n\n## Step\n[Current step]\n\n## Task\n[Investigation details]"
```

**⚠️ CRITICAL:** Never just mention "delegate to investigator". Always use Task tool explicitly.
