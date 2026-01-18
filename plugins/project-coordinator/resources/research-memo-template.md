# Research Memo Template

Use this template for `.claude/project-coordinator/research_memo.md`

```markdown
# Investigation: [Topic]

## Current Status
[One-line summary]

## Hypotheses

### Active
1. **[Hypothesis]** - Confidence: [Low/Med/High]
   - Evidence for: ...
   - Evidence against: ...
   - Next test: ...

### Eliminated
1. ~~[Hypothesis]~~ - Eliminated because: [reason]

## Investigation Log

### [YYYY-MM-DD HH:MM] - [Action taken]
**Goal:** What we were trying to learn
**Method:** What we did
**Result:** What happened
**Conclusion:** What this tells us
**Next:** What to do next

## Dead Ends (Important!)
- [Approach tried] → [Why it didn't work]

## Key Findings
- [Verified finding with evidence]
```

## Logging Rules

- Write BEFORE context compaction (vague post-compaction logs are useless)
- Log commands, files examined, hypotheses tested, dead ends
- Be specific: "Examined /var/log/app.log:1000-1500, found error X at line 1234" not "Checked the logs"
