# Project Coordinator Plugin

Manage complex, uncertain tasks. Provide visibility and prevent losing track of objectives.

## Structure

```
plugins/project-coordinator/
├── skills/
│   ├── project-coordinator/SKILL.md  ← Main orchestration skill
│   └── purpose-extraction/SKILL.md   ← Purpose clarification skill
├── agents/
│   ├── coordinator.md                ← Project coordination, monitoring
│   └── investigator.md               ← Investigation specialist agent
└── resources/
    └── ...                           ← Templates, best practices
```

## Installation

```bash
claude mcp add-json project-coordinator '{
  "type": "local",
  "path": "/path/to/plugins/project-coordinator"
}'
```

Or via Claude Code marketplace if available.

## Architecture

### Agent Teams mode

```
[User] <-> [Lead (main session)]
                  |
            TeamCreate + TaskCreate
                  |
           ┌──────┴──────┐
           v              v
    [coordinator]   [investigator]
     plan & monitor    investigate
           |              ^
           └──SendMessage──┘
```

- **Lead**: Launches team, assigns project task to coordinator, waits for reports
- **coordinator**: Creates plan.md, delegates investigation to investigator, monitors progress
- **investigator**: Systematic investigation (hypothesis testing, root cause analysis)

### Subagent mode (fallback)

```
[User] <-> [Main Agent + skills]
                    |
                Task tool
                    v
            [investigator]
```

Main session acts as coordinator directly, calling investigator via Task tool.

### Why Skills + Agents

| Component | Type | Reason |
|-----------|------|--------|
| project-coordinator | Skill | User visibility, compaction resilience, team launch |
| purpose-extraction | Skill | Requires frequent user dialogue |
| coordinator | Agent | Autonomous plan management, monitoring loop |
| investigator | Agent | Deep focus, context isolation, "dig and return" pattern |

## Managed Files

During project execution, `.claude/project-coordinator/` contains:

| File | Owner | Purpose |
|------|-------|---------|
| purpose.md | Lead (skill) | Immutable objective, success criteria |
| plan.md | coordinator | Plan, progress, risks |
| work_summary.md | investigator | Investigation summary |
| work_log_XX.md | investigator | Detailed investigation logs |
