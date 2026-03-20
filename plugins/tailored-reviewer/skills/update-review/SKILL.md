---
name: update-review
description: >
  This skill should be used when the user asks to "update review skills",
  "refresh skills", "apply feedback", "レビュースキルを更新",
  "フィードバックを反映", or when triggered by knowledge-base changes,
  new feedback entries, or plugin version updates.
argument-hint: [--full to update all skills, default: changed only]
---

# Update Review: Differential Skill Updates

Update generated review skills based on changes without full regeneration.

**Prerequisites:** Generated skills exist in .claude/skills/

## Trigger Detection

Check these conditions and determine what needs updating:

### 1. Knowledge-Base Changes

Compare knowledge-base file timestamps with `meta/last-updated.md`:
- If any knowledge-base file is newer → identify which skills reference that data
- Update only affected perspectives

### 2. Feedback

Check for new entries in:
- `feedback/missed-bugs.md` → identify which perspective should have caught it → add the pattern
- `feedback/veteran-edits/` → read the diff, understand the improvement → apply to affected skill

### 3. Plugin Version Update

Compare `meta/plugin-version-used.md` with `${CLAUDE_PLUGIN_ROOT}/VERSION`:
- If different → run with `--full` flag (regenerate all skills with new templates/knowledge)

## Update Process

### For Targeted Updates

1. Read the changed source (knowledge-base file or feedback entry)
2. Read the affected skill(s)
3. Identify which sections need modification
4. Apply minimal edits:
   - New bug pattern → add to "Short-term Detriments" or "Project-Specific Patterns"
   - Design principle change → update deviation detection rules
   - Missed bug feedback → add specific check for that pattern
   - Veteran edit → apply the veteran's improvement pattern
5. Run debug-review on updated skills only

### For Full Updates (--full or version change)

1. Read ALL knowledge-base files
2. Re-read archetype checklists and templates from generate-review references
3. For each existing skill: compare against what would be generated fresh
4. Apply improvements while preserving project-specific customizations added by veterans
5. Run debug-review on all skills
6. Run dry-run if test cases exist

## Output

Report:
- Skills updated: [list]
- Changes applied: [summary per skill]
- Debug-review result: pass/fail
- If version update: new features applied from updated templates
