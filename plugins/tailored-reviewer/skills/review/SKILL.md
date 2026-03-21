---
name: review
description: >
  This skill should be used when the user asks to "review", "review PR",
  "review code", "run review", "レビュー", "レビューして", "PRレビュー",
  "コードレビュー", or wants to execute the tailored review system
  against a PR, module, or incident.
argument-hint: [PR #123 | module src/ | incident description]
---

# Review: Execute Tailored Review

Run the project-specific review orchestrator against a target.

**Prerequisites:**
- Generated skills exist in .claude/skills/ (from /build-skills)
- .claude/skills/review-orchestrator/SKILL.md exists
- workspace/ contains the project clone

## Process

1. Read `.claude/skills/review-orchestrator/SKILL.md`
2. Follow the orchestrator's instructions exactly — it handles perspective selection, parallel dispatch, fact-check, design critique, contradiction detection, and consolidation
3. The orchestrator will save the review to `reviews/`

If `.claude/skills/review-orchestrator/SKILL.md` does not exist, inform the user to run `/build-skills` first.
