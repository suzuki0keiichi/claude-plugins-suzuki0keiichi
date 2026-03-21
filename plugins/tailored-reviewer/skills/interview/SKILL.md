---
name: interview
description: >
  This skill should be used when the user asks to "set up tailored review",
  "interview for review", "collect project information", "initialize review project",
  "プロジェクト情報を収集", "レビュー用の情報を集めて", "インタビューして",
  or needs to collect project-specific knowledge for review skill generation.
  Also triggered when existing knowledge-base files have stale last_verified dates,
  or when tailored-reviewer version has changed since last interview.
argument-hint: [project-directory-name]
---

# Interview: Project Knowledge Collection

Collect project-specific knowledge through a structured 3-phase process. The output feeds into build-skills to create tailored review skills.

**Prerequisites:** You must be in a tailored-reviewer-data project directory (contains config.md or will be created).

## Phase 1: Information Source Mapping

Map where project information lives. Ask the user one category at a time. Provide concrete examples to help them think of sources they might forget.

### Questions to Ask

Ask these in order. For each, provide examples of what you're looking for:

1. **Repository structure**
   - "Is this a monorepo or multi-repo? What's the main repo URL?"
   - "Are there related repos (shared libraries, infrastructure, etc.)?"

2. **Bug & task tracking**
   - "Where do you track bugs? JIRA, GitHub Issues, ClickUp, Linear?"
   - "Is it one project per workspace or shared? What labels/filters identify bugs?"
   - "What bug tracking source should health-score use for bug occurrence trends?"

3. **Error monitoring**
   - "Do you use Sentry, Datadog, or similar? What's the project/service name?"
   - "Is there a separate staging vs production monitoring?"

4. **Communication channels**
   - "Which Slack/Teams channels are relevant? There's often more than one:"
   - "  - General dev discussion"
   - "  - Incident/alert channels"
   - "  - Review request channels"
   - "  - Deploy notification channels"

5. **Documentation**
   - "Where are specs? Design docs? Meeting notes? Postmortems?"
   - "These are often scattered — Confluence, Notion, Google Docs, repo wiki..."
   - "For each: what's the space/folder/URL pattern?"

6. **Code quality tools**
   - "SonarQube? ESLint/Prettier configs? Any custom linting?"

7. **Roadmap & planning**
   - "Where's the roadmap? Product specs? Sprint planning docs?"

8. **Available Claude Code tools**
   - "Which MCP servers do you have installed? (Slack MCP, Jira MCP, etc.)"
   - "This determines what I can read automatically in Phase 2."

### Output

Write results to:
- `config.md` — frontmatter (project_name, git_url, default_branch) + information source sections with full detail (see spec for format)
- `knowledge-base/source-map.md` — structured map of all identified sources with access methods

## Phase 2: AI Self-Reading

Read from sources identified in Phase 1. Use only tools available in the user's Claude Code environment (MCP servers, gh CLI, git, file system). Do NOT attempt to access tools that aren't installed.

### Reading Process

Execute these in order. For each, write results to the appropriate knowledge-base file with metadata frontmatter:

```yaml
---
last_verified: YYYY-MM-DD
update_frequency: monthly | weekly
confidence: 0.0-1.0
sources:
  - "source description (date)"
---
```

1. **Repository analysis** → `knowledge-base/project-context.md`
   - Read README, CONTRIBUTING, architecture docs
   - Identify tech stack from package.json / requirements.txt / go.mod / etc.
   - Map directory structure and module boundaries

2. **Design principles** → `knowledge-base/design-principles.md`
   - Read any architecture/design documentation
   - If docs are missing or outdated (compare doc dates with code reality): **infer from code patterns**
   - Mark inferred principles with `sources: ["コード推論: {path} のパターンから"]`

3. **Implementation principles** → `knowledge-base/implementation-principles.md`
   - Read linting configs, CLAUDE.md, coding guidelines
   - Extract patterns from recent PRs (naming, error handling, testing style)

4. **Bug patterns** → `knowledge-base/bug-patterns.md`
   - Run: `${CLAUDE_PLUGIN_ROOT}/scripts/extract-fix-patterns.sh <workspace-path>`
   - Analyze the output: which directories have most fixes? What types of bugs recur?

5. **PR review patterns** → `knowledge-base/pr-review-patterns.md`
   - Run: `${CLAUDE_PLUGIN_ROOT}/scripts/extract-pr-comments.sh <owner/repo>`
   - Analyze: which reviewers comment most on which areas? What do they repeatedly flag?

6. **Roadmap** → `knowledge-base/roadmap.md`
   - Read roadmap docs if accessible via installed tools
   - If not accessible: mark confidence as low, flag for Phase 3

7. **Team context** → `knowledge-base/team-context.md`
   - Infer from git log (active contributors, areas of ownership)
   - Note: much of this requires user input in Phase 3

### Staleness Detection

When reading documents, compare document dates with code reality:
- Design doc says "microservices architecture" but code is a monolith → flag as stale
- API doc lists endpoints that don't exist in code → flag as stale
- Flag stale sources in the metadata: `confidence: 0.3, sources: ["STALE: doc.md (2024-01) vs code reality"]`

## Phase 3: Gap-Fill Questions

Review all knowledge-base files. For each:

- **confidence < 0.8**: Ask the user a specific, answerable question
  - Good: "I see src/payments/ has frequent fixes. Is there a known issue with the payment gateway integration?"
  - Bad: "Tell me about undocumented aspects of your project"
- **confidence >= 0.8**: Include in a final summary for bulk confirmation

### Final Summary

Present a bulleted summary of everything collected, grouped by knowledge-base file. Ask the user to confirm or correct. Update files based on their response.

## Update Mode

When run on a project that already has knowledge-base files:

1. Check `last_verified` + `update_frequency` on each file
2. Stale files → re-run the relevant Phase 2 step
3. Check for inconsistencies between per-review data and stored knowledge
4. Run Phase 3 only for items with decreased confidence

## After Interview

1. If workspace/ doesn't exist: `git clone <git_url> workspace/`
2. Write `meta/plugin-version-used.md` with current tailored-reviewer version
3. Write `meta/last-updated.md` with current timestamps per file
4. Prompt user: "Knowledge base is ready. Run /build-skills to create project-specific review skills."
