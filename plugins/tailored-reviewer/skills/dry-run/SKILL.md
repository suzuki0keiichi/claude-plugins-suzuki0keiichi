---
name: dry-run
description: >
  This skill should be used when the user asks to "test review skills",
  "dry run", "check detection rate", "レビュースキルをテスト",
  "検出率を測定", "ドライラン", or wants to verify that generated
  review skills can detect known bugs.
argument-hint: [--add-case to add a test case instead of running]
---

# Dry Run: Review Skill Detection Testing

Test generated review skills against known bugs to measure detection rate.

**Prerequisites:**
- Generated skills exist in .claude/skills/
- workspace/ contains the project clone

## Test Case Management

### Adding Test Cases

When invoked with `--add-case` or when the user wants to add a test case:

Prompt for:
1. **Source**: Where was this bug found? (PR #, JIRA ticket, Sentry event, postmortem, Slack thread)
2. **Commit**: The commit that introduced the bug (or the fix commit to reverse-engineer from)
3. **Description**: What was the bug?
4. **Expected detection**: Which perspective(s) should catch this?

Append to `dry-run/test-cases.md`:

```markdown
### Case [N]: [brief title]
- **Source**: [PR/JIRA/Sentry/postmortem reference]
- **Bug commit**: [hash]
- **Fix commit**: [hash] (if available)
- **Description**: [what the bug was]
- **Expected perspective**: [which perspective should detect it]
- **Added**: [date]
```

### Bulk Import

When importing from interview data:
- Scan bug-patterns.md for commits with both bug-introducing and fix commits identified
- Auto-generate test cases for each

## Running Dry Run

### Execution Flow

For each test case in `dry-run/test-cases.md`:

1. **Checkout**: `cd workspace && git checkout {bug_commit}~1` (state just before the bug)
2. **Generate diff**: `git diff {bug_commit}~1 {bug_commit}` (the buggy change)
3. **Execute review**: Run the review orchestrator against this diff
4. **Evaluate**: Did any finding match the known bug?
   - Match criteria: same file, related description, severity >= Important
   - Partial match: right area but wrong specific issue
   - Miss: no finding related to the known bug

5. **Restore**: `cd workspace && git checkout {default_branch}`

### Results

Write to `dry-run/results/YYYY-MM-DD.md`:

```markdown
# Dry Run Results: [date]

## Summary
- Test cases: N
- Detected: N (X%)
- Partial: N (X%)
- Missed: N (X%)
- False positives per case: avg N

## Per-Case Results

### Case [N]: [title]
- **Result**: detected / partial / missed
- **Detecting perspective**: [which perspective found it, if any]
- **Finding**: [the relevant finding, if any]
- **Notes**: [why it was missed, if applicable]

## Analysis

### Weak Areas
[Perspectives or bug types with low detection rate]

### Recommendations
[Specific suggestions for skill improvement based on misses]
```

## Interpretation

- Detection rate > 70%: good for initial deployment
- Detection rate 40-70%: usable but needs skill refinement
- Detection rate < 40%: skills need significant rework, feed results to update-review

Compare with previous dry-run results to track improvement over time.
