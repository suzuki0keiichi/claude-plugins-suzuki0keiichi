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

### Step 2: Detect Tech Stack and Project Archetype

**2a: Detect tech stack** from workspace/ (package.json, requirements.txt, Cargo.toml, etc.):
- Frameworks: Next.js (Pages/App Router), React, Vue, Express, FastAPI, etc.
- Databases: PostgreSQL, MySQL, MongoDB, Redis, Prisma ORM, etc.
- Runtime: Node.js, Python, Go, Rust, etc.
- Infrastructure: Docker, Kubernetes, serverless, edge, etc.

**2b: Classify archetype**:

| Signal | Archetype |
|--------|-----------|
| Next.js/React/Vue + API routes | Web Application |
| gRPC/REST services + Docker/K8s | Backend Service / Microservice |
| Spark/Airflow/Kafka consumers | Data Pipeline |
| Swift/Kotlin + mobile frameworks | Mobile Application |
| C/C++/Rust + hardware interfaces | Embedded / Real-time |
| Large single repo + tight coupling | Legacy Monolith |

Projects may match multiple archetypes. Include all that apply.

### Step 3: Generate Technical Concern Perspectives

Read `${CLAUDE_PLUGIN_ROOT}/skills/generate-review/references/archetype-checklists.md` (Technical Concern Perspectives section).

Always generate these 6 perspectives:
1. execution-flow
2. resource-management
3. concurrency
4. security
5. platform-constraints
6. implementation-quality

For each, use the **Technical Concern SKILL.md Template** from skill-templates.md:
- Populate check items from archetype-checklists.md
- Overlay tech-stack-specific checks from `${CLAUDE_PLUGIN_ROOT}/skills/generate-review/references/tech-patterns/{stack}.md` (if exists for detected stack)
- **Selective knowledge-base injection**: only include knowledge-base entries relevant to this specific concern (NOT the full knowledge-base)
  - For concurrency: race condition patterns from bug-patterns.md, transaction-related principles
  - For security: auth-related patterns, data exposure rules
  - For implementation-quality: coding conventions from implementation-principles.md
  - etc.

### Step 4: Generate Domain Perspectives

Read archetype-checklists.md (Domain Perspective Archetypes section).

For each matched archetype:
1. Include all REQUIRED domain perspectives
2. Check CONDITIONAL perspectives against knowledge-base — include if relevant data exists
3. DO NOT duplicate what the 6 technical concern perspectives already cover
   - e.g., if "Authentication & Authorization" is already covered by the security concern, only generate a domain perspective if there are project-specific auth rules beyond standard security checks

For each domain perspective, use the **Domain SKILL.md Template**:
- Fill in project-specific content from knowledge-base
- Convert bug-patterns.md entries → specific check items
- Convert pr-review-patterns.md entries → reviewer knowledge
- Convert design-principles.md → deviation detection rules

### Step 5: Write All SKILL.md Files

Write all generated skills to `.claude/skills/{perspective-id}/SKILL.md`.
Generate orchestrator, debate, and consolidation skills from their templates,
filling in the FULL perspective list (technical + domain) and project name.

### Step 6: Completeness Verification

Before finishing, verify:

- [ ] All 6 technical concern perspectives are generated
- [ ] Each technical concern has tech-stack-specific checks (not just generic)
- [ ] Domain perspectives don't duplicate technical concerns
- [ ] Knowledge-base injection is selective (each skill only has relevant KB entries)
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
