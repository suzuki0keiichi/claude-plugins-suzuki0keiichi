---
name: purpose-guard
description: This skill should be used when the user asks to "manage this complex task", "track this project", "coordinate this work", "I keep losing track", "investigate this bug", "このタスクを管理して", "進捗を追跡して", "迷子になってきた", "このバグを調査して", or mentions project coordination, purpose tracking, or plan management. Provides orchestration for complex, uncertain tasks while maintaining focus on original objectives.
---

# Purpose Guard Skill

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

Spawn a team with two teammates:

1. **coordinator**: Read `${CLAUDE_PLUGIN_ROOT}/agents/coordinator.md` and use as teammate instructions. Pass purpose.md and plan.md content as context.
2. **investigator**: Read `${CLAUDE_PLUGIN_ROOT}/agents/investigator.md` and use as teammate instructions. Pass current step details.

Coordinator monitors investigator, detects loops and purpose drift. User can message either teammate directly (Shift+Up/Down).

### Subagent mode (when Agent Teams is not available)

Read `${CLAUDE_PLUGIN_ROOT}/agents/coordinator.md` and apply its principles in this session.

For investigation tasks, call investigator via Task tool:
```
Task tool:
  subagent_type: "project-coordinator:investigator"
  prompt: "## Context\n[Purpose summary]\n\n## Step\n[Current step]\n\n## Task\n[Investigation details]"
```

**⚠️ CRITICAL:** Never just mention "delegate to investigator". Always use Task tool explicitly.
