---
name: submit-feedback
description: >
  This skill should be used when the user asks to "submit feedback",
  "report improvement", "create plugin issue", "フィードバックを送信",
  "プラグインの改善提案", or when veteran edits contain patterns
  that would benefit all tailored-reviewer users, not just this project.
---

# Submit Feedback: Plugin Improvement Proposals

Analyze veteran edits and other feedback to generate improvement proposals for the tailored-reviewer plugin itself.

**Prerequisites:** feedback/veteran-edits/ contains diffs of manual skill modifications.

## Process

### Step 1: Analyze Veteran Edits

Read all diffs in feedback/veteran-edits/. For each:

1. What was changed? (added check, modified wording, restructured flow)
2. Why was it changed? (infer from the diff context)
3. Is this project-specific or universal?

### Step 2: Classify

- **Project-specific**: The edit adds a check for "our payment gateway's specific error code"
  → This stays in this project's skills only. Feed to update-review.
- **Universal improvement**: The edit improves how confidence scoring works, or adds a check
  that any project of this archetype would benefit from
  → This should become a plugin improvement.

### Step 3: Generate GitHub Issue

For universal improvements, create a GitHub Issue:

```bash
gh issue create \
  --repo suzuki0keiichi/tailored-reviewer \
  --title "Skill generation improvement: [brief description]" \
  --body "$(cat <<'ISSUE_BODY'
## Source

Veteran edit on project: [project-name]
Date: [date]

## What Was Changed

[Description of the edit]

## Original (generated)

```
[relevant section before edit]
```

## Improved (veteran edit)

```
[relevant section after edit]
```

## Proposed Plugin Change

[How this should be incorporated into generate-review templates or archetype checklists]

## Classification

- Archetype: [which archetype this applies to, or "all"]
- Component: [archetype-checklists / skill-templates / generate-review logic]
ISSUE_BODY
)"
```

### Step 4: Report

- Issues created: [count]
- Project-specific edits (not submitted): [count]
- Summary of submitted improvements
