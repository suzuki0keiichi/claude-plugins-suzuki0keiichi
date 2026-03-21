---
name: update-skills
description: >
  This skill should be used when the user asks to "update skills",
  "update review skills", "refresh skills", "apply feedback",
  "スキルを更新", "レビュースキルを更新", "フィードバックを反映",
  or when triggered by knowledge-base changes, new feedback entries,
  or plugin version updates.
argument-hint: [--full to update all skills, default: changed only]
---

# Update Skills: Differential Skill Updates

Update generated review skills based on changes without full regeneration.
Handles both updating existing skills AND adding new ones that don't exist yet.

## Step 0: Environment Setup (MUST do first)

The current directory is the **review data project** (e.g., `~/review/rclc/`). This directory contains:
- `config.md` — project configuration
- `knowledge-base/` — collected project knowledge
- `meta/` — metadata files (plugin-version-used.md, build-inputs.md, etc.)
- `workspace/` — git clone of the actual project
- `.claude/skills/` — generated skill files

**All paths in this skill are relative to this project root.**
- `meta/` means the project root's `meta/`, NOT `.claude/skills/meta/`
- Generated/updated skills go to `.claude/skills/{perspective-id}/SKILL.md`

**Prerequisites:** Generated skills exist in .claude/skills/

## Trigger Detection

Check these conditions and determine what needs updating.
Read `meta/build-inputs.md` to get the hashes of reference files used in the last generation.
If `meta/build-inputs.md` does not exist, treat ALL inputs as changed (equivalent to --full).

### 1. Build Input Changes (plugin reference files)

Compare current hashes of plugin reference files against `meta/build-inputs.md`:

```bash
shasum -a 256 <file> | cut -c1-8
```

Check each file listed in `meta/build-inputs.md` under "Reference File Hashes":

| Changed file | Affected skills |
|-------------|----------------|
| archetype-checklists.md | All 8 perspectives + orchestrator |
| high-impact-patterns.md | Technical concerns matching changed condition IDs |
| templates/orchestrator.md | Orchestrator only |
| templates/technical-concern.md | All 8 perspectives |
| templates/domain-perspective.md | All domain perspectives |
| templates/debate.md | Debate only |
| templates/consolidation.md | Consolidation only |
| tech-patterns/{stack}.md | Technical concerns using that stack |

### 2. Missing Perspectives Detection (CRITICAL)

Read `${CLAUDE_PLUGIN_ROOT}/skills/build-skills/references/archetype-checklists.md` and list all mandatory perspectives defined there. Then check which ones exist in `.claude/skills/`:

```
Required by archetype-checklists:
1. execution-flow       → exists? check .claude/skills/execution-flow/SKILL.md
2. resource-management  → exists?
3. concurrency          → exists?
4. security             → exists?
5. platform-constraints → exists?
6. implementation-quality → exists?
7. code-health          → exists?
```

**If any required perspective is MISSING, it must be GENERATED (not just reported).** This is the most common case when the plugin adds a new perspective — existing projects need it added.

### 3. Knowledge-Base Changes

Compare knowledge-base file hashes against `meta/build-inputs.md` under "Knowledge Base Hashes":
- If any knowledge-base file hash changed → identify which skills reference that data
- Update only affected perspectives

### 4. Feedback and Backtest Learnings

Check for new entries in:
- `backtest/learnings.md` → compare hash against `meta/build-inputs.md`. If changed, each new learning specifies a target perspective → update only that perspective.
- `feedback/missed-bugs.md` → identify which perspective should have caught it → add the pattern
- `feedback/veteran-edits/` → read the diff, understand the improvement → apply to affected skill

### 5. Plugin Version Update

Compare `meta/plugin-version-used.md` with `${CLAUDE_PLUGIN_ROOT}/VERSION`:
- If different → run with `--full` flag

## Update Process

### For Missing Perspectives (from Trigger Detection #2)

For each missing perspective:
1. Read the corresponding section in `${CLAUDE_PLUGIN_ROOT}/skills/build-skills/references/archetype-checklists.md`
2. Read the template: `${CLAUDE_PLUGIN_ROOT}/skills/build-skills/references/templates/technical-concern.md`
3. Read tech-patterns for detected stack(s): `${CLAUDE_PLUGIN_ROOT}/skills/build-skills/references/tech-patterns/{stack}.md`
4. Read knowledge-base files relevant to this perspective
5. **Generate the SKILL.md** — write to `.claude/skills/{perspective-id}/SKILL.md`
6. **Update the orchestrator** — add the new perspective to `.claude/skills/review-orchestrator/SKILL.md`:
   - Add to perspective count
   - Add to Technical/Domain perspective list
   - Add Agent dispatch entry in Phase 1
7. Run debug-review on the new skill

This is NOT optional. Detecting a missing perspective and only reporting it is a failure.

### For Targeted Updates (existing skills)

1. Identify changed inputs from Trigger Detection above
2. For each affected skill:
   a. Read the current generated skill
   b. Read the changed input (reference file, knowledge-base entry, or learning)
   c. Apply minimal edits to incorporate the change
   d. Preserve project-specific customizations (veteran edits, manual additions)
3. Run debug-review on updated skills only
4. Update `meta/build-inputs.md` with new hashes for the changed files

### For Full Updates (--full or version change)

1. Read ALL knowledge-base files
2. Re-read archetype checklists and templates from build-skills references
3. Check for missing perspectives (Trigger Detection #2) and generate them
4. For each existing skill: compare against what would be generated fresh
5. Apply improvements while preserving project-specific customizations added by veterans
6. Run debug-review on all skills
7. Run backtest if test cases exist
8. Rewrite `meta/build-inputs.md` with all current hashes

## Output

Report:
- Trigger: [what changed — list of files with old/new hashes]
- **Skills added**: [list of newly generated perspectives]
- Skills updated: [list]
- Skills unchanged: [list]
- Changes applied: [summary per skill]
- Orchestrator updated: yes/no
- Debug-review result: pass/fail
- If version update: new features applied from updated templates
