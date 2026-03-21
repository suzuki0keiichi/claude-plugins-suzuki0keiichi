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
3. **Execute review**: Run the review orchestrator against this diff, with the `--backtest` context flag. The orchestrator's consolidation step will save the review to `reviews/` as usual — backtest does NOT change the review output location.
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

The review itself is saved to `reviews/` by the orchestrator (same as any normal review).
The backtest evaluation (recall/precision analysis) is written separately to `backtest/results/YYYY-MM-DD-{target}.md`:

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

## Learning Extraction (backtest後に自動実行)

backtestの結果からMISS/Partialを分析し、`backtest/learnings.md` に構造化して追記する。
このファイルは `generate-review` と `update-review` が読み込み、スキル生成に反映する。

### 抽出プロセス

各 MISS または Partial match について：

1. **根本原因分析**: なぜ検出できなかったか？
   - どのパースペクティブが担当すべきだったか
   - 既存のチェック項目の何が不足していたか
   - どういうチェックがあれば検出できたか

2. **パターン抽出**: 再利用可能な検出ルールに変換
   - 具体的なバグ→汎用的なチェックパターンに抽象化
   - 例: 「locked issueガード欠如」→「同一データセットを処理する並列関数間で防御的チェックが非対称」

3. **追記**: `backtest/learnings.md` に以下の形式で追記

```markdown
### Learning [N]: [パターン名]
- **Source**: backtest [date], Case [N] (MISS/Partial)
- **Bug**: [何が起きたか]
- **Root cause**: [なぜ検出できなかったか]
- **Check to add**: [具体的に何をチェックすべきか]
- **Target perspective**: [どのパースペクティブに追加すべきか]
- **Pattern type**: code-symmetry / state-transition / boundary-check / ...
- **Added**: [date]
```

**既存の learning と重複する場合は追記しない。**

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
