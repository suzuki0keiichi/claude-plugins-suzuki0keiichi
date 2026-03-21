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

# Update Review: Differential Skill Updates

Update generated review skills based on changes without full regeneration.

**Prerequisites:** Generated skills exist in .claude/skills/

## Trigger Detection

Check these conditions and determine what needs updating.
Read `meta/build-inputs.md` to get the hashes of reference files used in the last generation.

### 1. Build Input Changes (plugin reference files)

Compare current hashes of plugin reference files against `meta/build-inputs.md`:

```bash
shasum -a 256 <file> | cut -c1-8
```

Check each file listed in `meta/build-inputs.md` under "Reference File Hashes":

| Changed file | Affected skills |
|-------------|----------------|
| archetype-checklists.md | All 6 technical concerns + orchestrator |
| high-impact-patterns.md | Technical concerns matching changed condition IDs |
| templates/orchestrator.md | Orchestrator only |
| templates/technical-concern.md | All 6 technical concerns |
| templates/domain-perspective.md | All domain perspectives |
| templates/debate.md | Debate only |
| templates/consolidation.md | Consolidation only |
| tech-patterns/{stack}.md | Technical concerns using that stack |

Only regenerate the affected skills, not all.

### 2. Knowledge-Base Changes

Compare knowledge-base file hashes against `meta/build-inputs.md` under "Knowledge Base Hashes":
- If any knowledge-base file hash changed → identify which skills reference that data
- Update only affected perspectives

### 3. Feedback and Backtest Learnings

Check for new entries in:
- `backtest/learnings.md` → compare hash against `meta/build-inputs.md`. If changed, each new learning specifies a target perspective → update only that perspective.
- `feedback/missed-bugs.md` → identify which perspective should have caught it → add the pattern
- `feedback/veteran-edits/` → read the diff, understand the improvement → apply to affected skill

### 4. Plugin Version Update

Compare `meta/plugin-version-used.md` with `${CLAUDE_PLUGIN_ROOT}/VERSION`:
- If different → run with `--full` flag

## Update Process

### For Targeted Updates (default)

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
3. For each existing skill: compare against what would be generated fresh
4. Apply improvements while preserving project-specific customizations added by veterans
5. Run debug-review on all skills
6. Run backtest if test cases exist
7. Rewrite `meta/build-inputs.md` with all current hashes

## Output

Report:
- Trigger: [what changed — list of files with old/new hashes]
- Skills updated: [list]
- Skills unchanged: [list]
- Changes applied: [summary per skill]
- Debug-review result: pass/fail
- If version update: new features applied from updated templates
