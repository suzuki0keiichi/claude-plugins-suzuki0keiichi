# Work Log Template

For `.claude/project-coordinator/work_log_XX_topic.md`

Naming: `work_log_01_auth_flow.md`, `work_log_02_db_connection.md`, etc.

```markdown
# Work Log: [step topic]

## Step Info

- **Plan Step:** [corresponding step in plan.md]
- **Goal:** [what this step should achieve]

## Trials

### Trial #1
- Action: [command/check]
- Expected: [predicted result]
- Actual: [real result]
- Match: YES / NO

### Trial #2
...

## Summary

- Result: [success/failure/aborted]
- Next: [report to coordinator]
```

## Rules

- Create at step start
- Log every trial (always record YES/NO)
- 5 "NO" → abort step, return
