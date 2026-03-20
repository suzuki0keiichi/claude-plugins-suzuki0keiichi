---
name: generate-review
description: >
  This skill should be used when the user asks to "generate review skills",
  "create review perspectives", "build review setup", "レビュースキルを生成",
  "レビューを作って", or after interview skill has populated the knowledge-base.
  This is the core of tailored-reviewer: it generates project-specific
  SKILL.md files that form a complete review system.
argument-hint: [--force to regenerate all]
---

# Generate Review Skills

Generate a complete set of project-specific review SKILL.md files based on the knowledge-base.

**Prerequisites:**
- knowledge-base/ directory exists with populated files
- config.md exists with project information
- workspace/ exists with project clone

## Process

### Step 1: Read Knowledge Base

Read ALL files in knowledge-base/:
- project-context.md
- source-map.md
- design-principles.md
- implementation-principles.md
- roadmap.md
- bug-patterns.md
- pr-review-patterns.md
- team-context.md

Note confidence levels. Low-confidence entries (<0.5) should be used cautiously in generated skills.

### Step 2: Determine Project Archetype

Analyze project-context.md and the code in workspace/ to classify:

| Signal | Archetype |
|--------|-----------|
| Next.js/React/Vue + API routes | Web Application |
| gRPC/REST services + Docker/K8s | Backend Service / Microservice |
| Spark/Airflow/Kafka consumers | Data Pipeline |
| Swift/Kotlin + mobile frameworks | Mobile Application |
| C/C++/Rust + hardware interfaces | Embedded / Real-time |
| Large single repo + tight coupling | Legacy Monolith |

Projects may match multiple archetypes. Include all that apply.

### Step 3: Select Perspectives

Read `${CLAUDE_PLUGIN_ROOT}/skills/generate-review/references/archetype-checklists.md`.

For each matched archetype:
1. Include all REQUIRED perspectives
2. Check CONDITIONAL perspectives against knowledge-base — include if relevant data exists
3. Always include UNIVERSAL perspectives

Deduplicate across archetypes. Merge overlapping perspectives into single comprehensive ones.

### Step 4: Generate SKILL.md Files

Read `${CLAUDE_PLUGIN_ROOT}/skills/generate-review/references/skill-templates.md`.

For each perspective:
1. Start from the template
2. Fill in project-specific content:
   - Convert bug-patterns.md entries → specific check items
   - Convert pr-review-patterns.md entries → reviewer knowledge encoded as instructions
   - Convert design-principles.md → deviation detection rules
3. Ensure both short-term and long-term detriment sections are substantive (not just headers)
4. Write to `.claude/skills/perspectives/{perspective-id}/SKILL.md`

Generate orchestrator, debate, and consolidation skills from their templates, filling in the perspective list and project name.

### Step 5: Completeness Verification

Before finishing, verify:

- [ ] Every archetype's required perspectives are covered
- [ ] Both short-term and long-term detriments exist in every perspective
- [ ] knowledge-base entries with unique patterns (bug hotspots, reviewer focus areas) are reflected
- [ ] Generated skills reference specific files/modules from the project, not just generic advice
- [ ] Orchestrator correctly lists all generated perspectives

### Step 6: Run Debug-Review

Automatically invoke the debug-review skill to validate the generated skills.
If debug-review reports issues, fix them and re-validate.

### Step 7: Skill-Reviewer Validation (Optional)

If plugin-dev plugin is installed, invoke its skill-reviewer agent on each generated SKILL.md.
If not installed, skip — debug-review provides sufficient validation.

### Step 8: Record Metadata

- Write current tailored-reviewer version to `meta/plugin-version-used.md`
- Update `meta/last-updated.md` with generation timestamp

## Output

Report to user:
- Number of perspectives generated
- List of perspective names with one-line descriptions
- Any warnings from debug-review
- Prompt: "Review skills generated. Run your review orchestrator from this project directory."
