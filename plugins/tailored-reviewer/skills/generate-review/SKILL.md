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

**MANDATORY — generate ALL 6 of these perspectives. No exceptions. No substitutions. No skipping.**

1. execution-flow
2. resource-management
3. concurrency
4. security
5. platform-constraints
6. implementation-quality

These are NOT alternatives to domain perspectives — they COEXIST with domain perspectives generated in Step 4. A project will have these 6 PLUS domain-specific perspectives.

**Do NOT replace these 6 with project-specific perspectives** (e.g., do not generate "shell-script-robustness" instead of "execution-flow"). Project-specific concerns go into domain perspectives in Step 4.

For each, read `${CLAUDE_PLUGIN_ROOT}/skills/generate-review/references/templates/technical-concern.md` and use the template:
- Populate check items from archetype-checklists.md
- Overlay tech-stack-specific checks from `${CLAUDE_PLUGIN_ROOT}/skills/generate-review/references/tech-patterns/{stack}.md` (if exists for detected stack)
- **Selective knowledge-base injection**: only include knowledge-base entries relevant to this specific concern (NOT the full knowledge-base)
  - For concurrency: race condition patterns from bug-patterns.md, transaction-related principles
  - For security: auth-related patterns, data exposure rules
  - For implementation-quality: coding conventions from implementation-principles.md
  - etc.

**Verification**: After generating, confirm you have exactly 6 files:
- `.claude/skills/execution-flow/SKILL.md`
- `.claude/skills/resource-management/SKILL.md`
- `.claude/skills/concurrency/SKILL.md`
- `.claude/skills/security/SKILL.md`
- `.claude/skills/platform-constraints/SKILL.md`
- `.claude/skills/implementation-quality/SKILL.md`

If any are missing, go back and generate them before proceeding to Step 4.

### Step 4: Generate Domain Perspectives

Read archetype-checklists.md (Domain Perspective Archetypes section).

For each matched archetype:
1. Include all REQUIRED domain perspectives
2. Check CONDITIONAL perspectives against knowledge-base — include if relevant data exists
3. DO NOT duplicate what the 6 technical concern perspectives already cover
   - e.g., if "Authentication & Authorization" is already covered by the security concern, only generate a domain perspective if there are project-specific auth rules beyond standard security checks

For each domain perspective, read `${CLAUDE_PLUGIN_ROOT}/skills/generate-review/references/templates/domain-perspective.md` and use the template:
- Fill in project-specific content from knowledge-base
- Convert bug-patterns.md entries → specific check items
- Convert pr-review-patterns.md entries → reviewer knowledge
- Convert design-principles.md → deviation detection rules

### Step 5: Write All SKILL.md Files

Write all generated skills to `.claude/skills/{perspective-id}/SKILL.md`.
Generate orchestrator, debate, and consolidation skills from their respective templates,
filling in the FULL perspective list (technical + domain) and project name:
- Orchestrator: read `${CLAUDE_PLUGIN_ROOT}/skills/generate-review/references/templates/orchestrator.md`
- Debate: read `${CLAUDE_PLUGIN_ROOT}/skills/generate-review/references/templates/debate.md`
- Consolidation: read `${CLAUDE_PLUGIN_ROOT}/skills/generate-review/references/templates/consolidation.md`

### Step 6: Completeness Verification

Before finishing, verify:

**Technical Concern Coverage (CRITICAL — failure here means restart Step 3):**
- [ ] execution-flow/SKILL.md exists
- [ ] resource-management/SKILL.md exists
- [ ] concurrency/SKILL.md exists
- [ ] security/SKILL.md exists
- [ ] platform-constraints/SKILL.md exists
- [ ] implementation-quality/SKILL.md exists

**Content Quality:**
- [ ] Each technical concern has tech-stack-specific checks (not just generic)
- [ ] Domain perspectives don't duplicate technical concerns
- [ ] Knowledge-base injection is selective (each skill only has relevant KB entries)
- [ ] knowledge-base entries with unique patterns (bug hotspots, reviewer focus areas) are reflected
- [ ] Generated skills reference specific files/modules from the project, not just generic advice

**Orchestrator Completeness:**
- [ ] Lists ALL generated perspectives (6 technical + domain)
- [ ] Has Phase 1.5 with workspace verification AND PR diff reconciliation
- [ ] Has Phase 1.7 Design Critique
- [ ] Has Phase 2 Contradiction Detection
- [ ] Has Phase 3 Consolidation dispatch

**Consolidation Completeness:**
- [ ] Has MANDATORY File Output section at the TOP
- [ ] File path uses `reviews/` directory
- [ ] Report format includes Design Critique section
- [ ] Report format includes workspace reconciliation drops in Fact-Check Log

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
