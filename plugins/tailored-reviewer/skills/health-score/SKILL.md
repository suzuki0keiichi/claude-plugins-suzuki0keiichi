---
name: health-score
description: >
  This skill should be used when the user asks to "check project health",
  "run health score", "health check", "プロジェクトの健康状態",
  "ヘルススコア", "健全性チェック", or on a schedule via cowork.
  Operates independently from review skills.
---

# Health Score: Project Health Tracking

Track project health metrics over time. Independent from review execution.

**Prerequisites:**
- config.md exists with project information and tool sources
- workspace/ contains the project clone

## Metrics Collection

### 1. Script-Based Metrics (Deterministic)

Run the health metrics script:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/health-metrics.sh <workspace-path>
```

This collects:
- File churn rates (last 30 days)
- Directory churn concentration
- Large file indicators
- Test-to-source ratio
- Fix commit frequency

### 2. External Tool Metrics

Check config.md for available tools. For each that exists, collect:

**Sentry** (if configured):
- Error rate: new errors in last 7 days vs previous 7 days
- Regression count: previously resolved errors that reappeared
- Use MCP or API if available

**Datadog** (if configured):
- Latency P95 trend: last 7 days vs previous 7 days
- Error rate trend
- Use MCP or API if available

**SonarQube** (if configured):
- Technical debt score change
- New security hotspots
- Use API if available

**Bug Tracker** (JIRA/GitHub Issues, as configured):
- New bugs filed in last 7 days
- Bug resolution rate
- Bug density by component/label
- Source identified during interview Phase 1

Skip any tool that isn't configured or accessible. Health score works with whatever is available.

### 3. Review Finding Accumulation

If previous review reports exist:
- Count Suggestion-level findings across recent reviews
- Track which areas accumulate repeated Suggestions
- Flag areas where Suggestion count is growing

## Analysis (LLM)

After collecting all available metrics, analyze:

1. **Relative changes**: Compare with previous health score (if exists in health/scores/)
2. **Trend detection**: Is any metric consistently worsening?
3. **Hotspot identification**: Which areas concentrate problems?
4. **Correlation**: Does high churn correlate with high bug rate in the same area?

## Output

Write to `health/scores/YYYY-MM-DD.md`:

```markdown
# Health Score: [date]

## Summary
- Overall trend: improving / stable / degrading
- Areas of concern: [count]

## Metrics

### Code Churn
[Top churning files/dirs with change counts]
[Trend vs last score: ↑/↓/→]

### Bug Activity
[New bugs, resolution rate, density]
[Trend vs last score]

### Fix Ratio
[Fix commits as % of total]
[Trend vs last score]

### Test Coverage Indicator
[Test-to-source ratio]
[Trend vs last score]

### External Tools
[Sentry/Datadog/SonarQube metrics, if available]

### Accumulated Review Findings
[Areas with growing Suggestion counts]

## Areas of Concern

[Specific areas where multiple metrics are degrading]

## Recommendations

[Actionable suggestions: "Consider reviewing src/payments/ — churn rate is 3x average
and bug density is increasing"]
```

Report to user with key findings summary.
