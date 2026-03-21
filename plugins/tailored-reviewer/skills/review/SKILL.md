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

## Step 0: Environment Setup (MUST do first)

The current directory is the **review data project** (e.g., `~/review/rclc/`). This directory contains:
- `config.md` — project configuration (read this for git URL and project info)
- `knowledge-base/` — collected project knowledge
- `meta/` — metadata files
- `workspace/` — git clone of the actual project
- `.claude/skills/` — generated review skills
- `reviews/` — review output destination

**IMPORTANT:**
- The project root is NOT a git repository. `workspace/` is.
- All git commands (`gh`, `git`) must run inside `workspace/`.
- All code reading must target `workspace/`.
- Review outputs go to `reviews/` at the project root.

## Process

1. Read `config.md` to get project info (git URL, repository name, etc.)
2. Read `.claude/skills/review-orchestrator/SKILL.md`
3. Follow the orchestrator's instructions exactly — it handles perspective selection, parallel dispatch, fact-check, design critique, contradiction detection, and consolidation
4. The orchestrator will save the review to `reviews/`

If `.claude/skills/review-orchestrator/SKILL.md` does not exist, inform the user to run `/build-skills` first.
