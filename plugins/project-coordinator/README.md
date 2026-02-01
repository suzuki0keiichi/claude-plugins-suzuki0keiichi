# Project Coordinator Plugin

Manage complex, uncertain tasks. Provide visibility and prevent losing track of objectives.

## Structure

```
plugins/project-coordinator/
├── skills/
│   ├── purpose-guard.md        ← Main orchestration skill
│   └── purpose-extraction.md   ← Purpose clarification skill
├── agents/
│   └── investigator.md         ← Investigation specialist agent
└── resources/
    └── ...                     ← Templates, best practices
```

## Installation

```bash
claude mcp add-json project-coordinator '{
  "type": "local",
  "path": "/path/to/plugins/project-coordinator"
}'
```

Or via Claude Code marketplace if available.

## Setup

### Add trigger to rules

Create `~/.claude/rules/project-coordinator-trigger.md`:

```markdown
Read and follow `plugins/project-coordinator/skills/purpose-guard.md` when:

1. **Starting complex tasks**
   - Tasks with 3+ steps
   - High uncertainty work (unclear solution, multiple retries expected)
   - Work where progress tends to get lost

2. **Ongoing project exists**
   - `.claude/project-coordinator/` directory contains files
   - MUST check after compaction
```

## Architecture

```
[User] <-> [Main Agent + skills]
                    |
                    v
            [investigator]
```

- **Main Agent**: Orchestration, user reporting (with skills)
- **investigator**: Systematic investigation (hypothesis testing, root cause analysis)

### Why Skills + Agent

| Component | Type | Reason |
|-----------|------|--------|
| purpose-guard | Skill | User visibility, compaction resilience |
| purpose-extraction | Skill | Requires frequent user dialogue |
| investigator | Agent | Deep focus, context isolation, "dig and return" pattern |

## Managed Files

During project execution, `.claude/project-coordinator/` contains:

| File | Owner | Purpose |
|------|-------|---------|
| purpose.md | Main (skill) | Immutable objective, success criteria |
| plan.md | Main (skill) | Plan, progress, risks |
| work_summary.md | investigator | Investigation summary |
| work_log_XX.md | investigator | Detailed investigation logs |
