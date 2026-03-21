---
name: debug-review
description: >
  This skill should be used when the user asks to "debug review skills",
  "validate generated skills", "check skill quality", "スキルをデバッグ",
  "生成スキルを検証", or automatically after build-skills completes.
  Validates that generated review skills are structurally correct,
  comprehensive, project-specific, and behaviorally sound.
---

# Debug Review: Generated Skill Validation

Validate the quality of generated review skills in .claude/skills/.

**Prerequisites:** Generated skills exist in .claude/skills/ (from build-skills).

## Validation Checks

Run ALL checks. Report results per-skill and as a summary.

### 1. Structure Validation

For each SKILL.md in .claude/skills/:

- [ ] Has valid YAML frontmatter with `name` and `description`
- [ ] Description contains trigger phrases
- [ ] Has clear section headers (not just a wall of text)
- [ ] Markdown is well-formed (no broken links, unclosed code blocks)

For orchestrator specifically:
- [ ] Lists all perspective skills by name
- [ ] Includes contradiction detection logic
- [ ] References debate and consolidation skills

### 2. Cross-Reference Integrity

- [ ] Every perspective listed in orchestrator exists as a file
- [ ] No orphan perspectives (files that orchestrator doesn't reference)
- [ ] Debate skill references the same output format as perspectives
- [ ] Consolidation skill references the confidence threshold (80)

### 3. Completeness Validation

For each perspective:
- [ ] Has "Short-term Detriments" section with specific checks (not empty)
- [ ] Has "Long-term Detriments" section with specific checks (not empty)
- [ ] Has "Project-Specific Patterns" section with content from knowledge-base (not generic)

Cross-check against knowledge-base:
- [ ] bug-patterns.md hotspot files are mentioned in at least one perspective
- [ ] pr-review-patterns.md frequent reviewer concerns are encoded somewhere
- [ ] design-principles.md principles have corresponding deviation checks

### 4. Specificity Validation

Each perspective MUST contain project-specific content. Flag if:
- All check items could apply to ANY project (too generic)
- No file paths, module names, or component names from the actual project
- No references to knowledge-base findings

Score: count project-specific references per perspective. Flag if < 3.

### 5. Instruction Compliance Validation

For each skill, simulate execution by reading the SKILL.md and verifying:
- [ ] Steps are numbered and unambiguous — an LLM reading this would know what to do first, second, third
- [ ] No step requires information that isn't provided or referenced
- [ ] Agent delegation instructions specify WHICH skill/agent to call (not vague "dispatch an agent")
- [ ] Output format is explicitly defined (not "output your findings")

### 6. Agent Delegation Validation

For orchestrator:
- [ ] Each perspective dispatch specifies the exact skill path
- [ ] Parallel dispatch is explicitly stated (not implied)
- [ ] Result collection from agents is described (how to gather outputs)
- [ ] Debate trigger condition is testable (not subjective)

### 7. Skip Detection

Read each skill as if you were an LLM following instructions. Flag if:
- [ ] A step could reasonably be skipped because it's vaguely worded
- [ ] A step's purpose is unclear, inviting the LLM to "interpret" rather than follow
- [ ] Conditional logic has ambiguous conditions ("if appropriate", "when relevant")
- [ ] Steps lack explicit "do this, then do that" sequencing

### 8. Template Compliance Validation

Read the templates in `${CLAUDE_PLUGIN_ROOT}/skills/build-skills/references/templates/` and verify that generated skills include all MANDATORY elements from their corresponding template (orchestrator.md, technical-concern.md, domain-perspective.md, debate.md, consolidation.md).

**Orchestrator MUST have:**
- [ ] Step 0: Environment Setup (workspace/ instruction, config.md reading)
- [ ] Phase 1.5 Step A: Workspace Verification (re-read cited code in workspace/)
- [ ] Phase 1.5 Step B: PR Diff vs Workspace Reconciliation (compare diff findings against current workspace code)
- [ ] Phase 1.7: Design Critique (purpose-implementation gap, omission detection, design alternative analysis)
- [ ] Phase 2: Contradiction Detection
- [ ] Phase 3: Consolidation dispatch

**Consolidation MUST have:**
- [ ] MANDATORY File Output section at the TOP (write to `reviews/` directory)
- [ ] Explicit file path format: `reviews/{YYYY-MM-DD}-{type}-{target}.md`
- [ ] Design Critique section in report format
- [ ] Fact-Check Log including workspace reconciliation drops

**Each Technical Concern perspective MUST have:**
- [ ] Check items from archetype-checklists.md for this concern
- [ ] Tech-stack-specific checks from tech-patterns/{stack}.md (not just generic)
- [ ] Selective knowledge-base injection (NOT full KB)
- [ ] Fact Check section

**If ANY mandatory element is missing: FAIL the validation and return to build-skills with the specific missing elements listed.**

### 9. Technical Concern Coverage Validation

Verify that ALL 6 standard technical concerns exist as generated skills:
- [ ] execution-flow
- [ ] resource-management
- [ ] concurrency
- [ ] security
- [ ] platform-constraints
- [ ] implementation-quality
- [ ] code-health

If ANY of the 7 are missing, this is a CRITICAL failure. These 7 are mandatory for all projects regardless of archetype.

Note: projects may ALSO have domain-specific perspectives in addition to these 7. The 7 perspectives and domain perspectives coexist — they are not alternatives.

## Output

### Validation Report

For each skill:
```
#### [skill-name]
- Structure: ✅/❌ [details]
- Completeness: ✅/❌ [details]
- Specificity: ✅/❌ [N project-specific references]
- Instruction Compliance: ✅/❌ [details]
- Agent Delegation: ✅/❌ [details] (orchestrator only)
- Skip Risk: ✅/❌ [details]
- Template Compliance: ✅/❌ [missing mandatory elements] (orchestrator, consolidation, perspectives)
- Technical Concern Coverage: ✅/❌ [missing concerns] (overall check)
```

Summary:
- Total skills validated: N
- Passed all checks: N
- Issues found: N (list with severity)

If issues found: return to build-skills with specific fix requests.
If all passed: report success.
