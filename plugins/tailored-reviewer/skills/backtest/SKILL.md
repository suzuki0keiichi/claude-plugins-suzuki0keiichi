---
name: backtest
description: >
  This skill should be used when the user asks to "backtest review skills",
  "test detection rate", "バックテスト", "レビュースキルをテスト",
  "検出率を測定", "過去のバグで検証", or wants to verify that generated
  review skills can detect known bugs by replaying historical states.
argument-hint: [--add-case to add a test case instead of running]
---

# Backtest: Review Skill Detection Testing

Test generated review skills against historical bugs by replaying the codebase
state at the time each bug was introduced. Measures both **recall** (did we catch
known bugs?) and **precision** (were our findings validated by subsequent fixes?).

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

Append to `backtest/test-cases.md`:

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

## Running Backtest

### Execution Flow

For each test case in `backtest/test-cases.md`:

1. **Checkout**: `cd workspace && git checkout {bug_commit}` (the state WITH the bug)
2. **Generate diff**: `git diff {bug_commit}~1 {bug_commit}` (the buggy change)
3. **Execute review**: Run the review orchestrator against this diff, with the `--backtest` context flag
4. **Evaluate detection** (recall): Did any finding match the known bug?
   - Match criteria: same file, related description, severity >= Important
   - Partial match: right area but wrong specific issue
   - Miss: no finding related to the known bug

5. **Evaluate precision** (forward validation): For findings that DON'T match the known bug:
   - Check if the cited code was modified in subsequent commits: `git log {bug_commit}..{default_branch} -- {file_path}`
   - If modified: read the fix commit diff to determine if the finding's concern was addressed
   - **Validated**: finding pointed to real code that was later changed to address the same concern
   - **Unvalidated**: finding pointed to code that was never subsequently changed (may be false positive, or unfixed issue)

6. **Restore**: `cd workspace && git checkout {default_branch}`

**IMPORTANT**: In step 1, we checkout `{bug_commit}` (NOT `{bug_commit}~1`). The workspace must contain the buggy code so that the orchestrator's Phase 1.5 fact-check (workspace verification) can confirm the bug exists. If the workspace were at `{bug_commit}~1`, the buggy code wouldn't exist in workspace and all findings would be falsely dropped.

### Results

Write to `backtest/results/YYYY-MM-DD.md`:

```markdown
# Backtest Results: [date]

## Summary
- Test cases: N
- Detected (recall): N/N (X%)
- Partial: N (X%)
- Missed: N (X%)
- Additional findings: N
  - Validated by subsequent fixes: N (X%)
  - Unvalidated: N

## Per-Case Results

### Case [N]: [title]
- **Known bug result**: detected / partial / missed
- **Detecting perspective**: [which perspective found it, if any]
- **Finding**: [the relevant finding, if any]
- **Notes**: [why it was missed, if applicable]
- **Additional findings**: N
  - Validated: [list findings that were later fixed, with fix commit hash]
  - Unvalidated: [list findings with no subsequent fix]

## Analysis

### Recall (known bug detection)
[Perspectives or bug types with low detection rate]

### Precision (forward validation)
[Rate of findings validated by subsequent fixes]
[High validation rate = review is finding real issues]
[Low validation rate = review may be producing noise]

### Recommendations
[Specific suggestions for skill improvement based on misses and validation rates]
```

## Interpretation

### Recall (known bug detection)
- Detection rate > 70%: good for deployment
- Detection rate 40-70%: usable but needs skill refinement
- Detection rate < 40%: skills need significant rework, feed results to update-review

### Precision (forward validation)
- Validation rate > 50%: excellent — review is finding real issues beyond the known bug
- Validation rate 20-50%: good — some noise but meaningful signal
- Validation rate < 20%: review may be producing too much noise

A review system with high recall AND high precision is genuinely useful — it catches known bugs and also surfaces issues that developers independently recognized and fixed.

Compare with previous backtest results to track improvement over time.
