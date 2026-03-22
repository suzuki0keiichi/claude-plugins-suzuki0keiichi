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
  → This stays in this project's skills only. Feed to update-skills.
- **Universal improvement**: The edit improves how confidence scoring works, or adds a check
  that any project of this archetype would benefit from
  → This should become a plugin improvement. Proceed to Step 3.

### Step 3: Sanitize (MUST do before showing to user)

Feedback will be submitted to a **public** GitHub repository. Remove all confidential information:

1. **Replace** project-specific file paths with generic examples (e.g., `src/detail/config.cpp` → `src/module/config.cpp`)
2. **Replace** internal variable/function/class names with generic equivalents (e.g., `PaymentGatewayClient` → `ExternalServiceClient`)
3. **Replace** company names, product names, internal domain names with placeholders (`[company]`, `[product]`)
4. **Remove** code snippets that contain business logic. Use pseudocode or describe the pattern instead.
5. **Remove** infrastructure details (internal URLs, IP addresses, credentials references)
6. **Keep** the structural pattern and the reason it matters — that's what the plugin improvement needs.

Example:
- Before: "Added check for `AcmeCorp::PaymentProcessor::validateNonce()` returning stale tokens after 3600s"
- After: "Added check for external service validation functions returning stale/expired values after timeout"

### Step 4: User Confirmation (MUST do before sending)

Present the sanitized feedback to the user:

```
以下の内容を suzuki0keiichi/claude-plugins-suzuki0keiichi の
GitHub Issue として送信します。機密情報が含まれていないか確認してください。

---
[sanitized issue content]
---

送信してよろしいですか？ (yes/no)
```

**Do NOT create the issue until the user explicitly approves.** If the user says no or requests changes, revise and re-present.

### Step 5: Submit

After user approval, create the GitHub Issue:

```bash
gh issue create \
  --repo suzuki0keiichi/claude-plugins-suzuki0keiichi \
  --title "tailored-reviewer improvement: [brief description]" \
  --body "[approved content]"
```

### Step 6: Report

- Issues created: [count]
- Project-specific edits (not submitted): [count]
- Summary of submitted improvements
