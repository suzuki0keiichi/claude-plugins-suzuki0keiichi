---
name: graphrag-knowledge
version: 4.3.0
description: プロジェクトの永続的な設計知識 (採用判断/却下案/制約/目的/リスク/運用知識と、それらを貫く横断構造) を vault を単一正本に安全に読み書きする。作業の最上流と一段落で発火する。【読み — 着手前に先に引く (コードやファイルを読む前にこれを起動)】① 「○○を実装/修正/改善/リファクタしたい」「○○がバグってる/動かない/エラー」「○○周りを整理/調査/レビュー/設計したい」と課題や依頼を受け取った直後、触る領域の Decision / Risk / Constraint / 運用知識を `ask` で先に引く (1発で網羅、連打しない)。② 「前回の続き」「引き継ぎ」「過去どう判断した」「なぜこの設計に」と経緯を問われた時。③ 「影響範囲」「どこに波及」と影響伝播を辿りたい時。【書き戻し — 一段落で能動的に (ユーザーの「覚えて」を待たない)】④⑤ 実装一段落・結論確定・却下・記録指示で書き戻す (詳細は §Proactive Persistence)。【初回】⑥ 未知のリポジトリを初回索引したい時。
---

# GraphRAG Knowledge

A skill that lets agents accumulate knowledge in a vault (Obsidian Markdown) as the single source of truth, enabling thorough decision-making even from vague requests. Defines retrieval procedures, focus continuity, read/write boundaries, mutation procedures, and reporting format.

## Overview / How to call

CLI for safely reading and writing a persistent knowledge graph. All verbs go through a single launcher:

```sh
node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts <verb> [args]
```

Hereafter `$CLI` = the launcher above, `$REF` = `${CLAUDE_PLUGIN_ROOT}/references`.

Verbs fall into 4 categories: read (`ask`), write (`add-*` / `commit-mutation`), index (`carve`), inspect (`inspect`). Details in §Recipe / §Headline verbs. Primitives (per-stage fine-grained operations) in §Primitive verbs + `$REF/cli-primitives.md`.

## Graph-backed review (sibling skills)

This skill is the read/write foundation. Three derived skills review changes and proposals at the concept level using the graph as backbone (shared method: `$REF/graph-review-method.md`). Goal is controllability ("delegate broadly, but don't cross the guardrails"), not QA. They advise, never hard-reject:

- `/graphrag-knowledge:graphrag-design-review` — pre-implementation design review against graph (knowledge axis)
- `/graphrag-knowledge:graphrag-pr-review` — PR/diff review against graph (crosscut axis + File), detecting concept deltas in 3 tiers
- `/graphrag-knowledge:graphrag-review-doc` — generate concept-level explanation doc (HTML) for human reviewers

## Invariants (non-negotiable design boundaries)

1. **Vault is the single source of truth.** Knowledge lives in the vault (frontmatter = canonical, body = human projection). Search, indexing, and writes all read the vault. `graph.json` is an indexer output / round-trip verification artifact, NOT the source of truth. Do not hand-edit vault for normal knowledge insertion (`commit-mutation` / `add-*` handle lock / OCC / atomic publish / git commit).
2. **Never let the LLM write raw queries.** The LLM touches exactly two surfaces:
   - Read: ranked JSON (`ask` / `brief` / `search` / `evidence` output).
   - Write: typed-add CLI args, or mutation plan JSON (`reason` / `nodes` / `edges`) validated and applied to the **vault** by `commit-mutation`.
   Any change that thins this layer or exposes a raw query path to the LLM is a design violation.
3. **Semantic is non-negotiable.** Search ranking combines lexical (exact/partial/word-coverage, normalized to [0,1]) and semantic (cosine, clamped to [0,1]) with equal weight (max 100 each). Lexical-only fallback is not designed for (no vector index → `ask` hard-errors).
4. **Vault round-trips.** Frontmatter (YAML) is canonical, body is human projection. The vault import→build round-trip equivalence test is the sole gate for serialization changes.

## Anti-patterns (DO NOT)

- **DO NOT translate "read/trace the graph" into grep / glob / read.** Do not read vault `.md` files directly — use `ask` instead. The CLI auto-discovers the vault (§Setup). `ask` works without knowing the vault path; if not found, it hard-errors. Falling back to grep is a design violation.
- **DO NOT grep / read `graphrag/*.ts` source code.** Everything the LLM needs is in this file and `$REF/`. Do not re-derive types from `schema.ts` (§Schema quick-ref is enough). Do not re-derive CLI invocation (`$CLI <verb>` is enough).
- **DO NOT edit `vault/` directly.** The vault is the source of truth, but write through `commit-mutation` / `add-*` only (CLI guarantees lock / OCC / atomic publish / git commit).
- **DO NOT create duplicate nodes.** Always check existing nodes via `ask` before creating. Prefer `skip` / `update` / `supersede` / `review` over new creation. The write-time duplicate gate (`duplicate_check`, §Mutation Plan) catches cosine ≥ 0.92 same-type nodes as a last resort, but **do not skip the `ask` pre-check just because the gate exists**. To acknowledge a suspect as intentionally distinct, use `--dup-ack <id[,id...]>`.
- **DO NOT write without verifying the target vault (worktree / subdirectory accidents).** When cwd changes (worktree, subdirectory, different branch checkout), you may write to the wrong vault or lose vault discovery entirely. **Run `inspect` before the first write in a session** to verify `vault_dir`. If unexpected, use `--vault <path>` or set `GRAPHRAG_VAULT_DIR` in `.graphrag/.env`.
- **DO NOT `git merge` vault files.** Git merge cannot detect semantic duplicates, missing lineage, or contradictory edges — it produces a broken vault. Use `branch-merge` → judgment packets → `commit-mutation` for semantic-unit application (§Parallel work, `$REF/branch-merge.md`).
- **DO NOT pollute the graph with session-local scratch** (§What to persist).

## Setup prerequisites (retrieval hard-errors without these)

- **Vault directory** must exist. Resolution order: **shell env `GRAPHRAG_VAULT_DIR` > closest `.graphrag/` (walk-up from cwd) > `.env` > parent `.graphrag/`**. The walk-up anchors on the *closest* `.graphrag/` directory that has either a `.env` or a `vault/` — so a worktree's own `.graphrag/vault` wins over a parent repo's `.graphrag/.env` (closest-wins; the walk-up does not descend into a parent's `.env` once a closer `.graphrag/` root is found). Placing the vault at `.graphrag/vault` requires zero env configuration. For vaults in external repos, set `GRAPHRAG_VAULT_DIR=<absolute-path>` in `.graphrag/.env` (most stable — walk-up discovery works from worktrees and subdirectories). Hard-errors if nothing found.
- OpenAI-compatible embedding endpoint. Auto-detects Ollama (`http://localhost:11434/v1`) and LM Studio (`http://localhost:1234/v1`) when unconfigured. Model pinned to `nomic-embed-text`. **Hard-errors** if unreachable.
- **Env-wide global config: `~/.graphrag/.env`.** Loaded last, at the lowest priority, as a fallback for keys local config didn't set. Put **per-machine** (not per-vault) values here — typically the vector-index embedding API server: `GRAPHRAG_EMBEDDING_ENDPOINT` / `GRAPHRAG_EMBEDDING_API_KEY` / `GRAPHRAG_EMBEDDING_MODEL`. This lets each repo's `.graphrag/.env` stay vault-only (`GRAPHRAG_VAULT_DIR`, `GRAPHRAG_VAULT_MODE`) and keep the endpoint in one place. Full priority (high→low): **shell env > local `.graphrag/.env` (walk-up) > cwd `.env` > auto-discovered `.graphrag/vault` > `~/.graphrag/.env`**. Loading is first-wins, so local always overrides the home fallback (a stray `GRAPHRAG_VAULT_DIR` in the home file cannot clobber a closer vault — #14 preserved).
- **Launcher reads `.env` once at startup.** All verbs see the same env — no per-verb inconsistency.
- **Output env** (only when vault resolution above is insufficient):
  - `GRAPHRAG_VAULT_DIR` = vault canonical path.
  - `GRAPHRAG_VAULT_MODE` = `readonly` | `direct` | `worktree` (write policy when vault is in an external repo). **When unset and vault is external, CLI hard-errors writes and forces user confirmation.**
  - `GRAPHRAG_GRAPH_JSON_PATH` = graph.json I/O path. Only needed for `index` / `carve` / `vault-build` / `vault-import`.

## Focus continuity and read-only triage

- Context continuity unit is focus / active Investigation, not session. New focus within same session = new context.
- Resume / active-focus check / next-action extraction are read-only triage. Do not start graph updates, vector index updates, or investigation cleanup during triage.
- Triage is not a completion condition. Unless the user only asked for status, report stale blockers and completed next_actions as candidates, then proceed to the main task.

## Retrieval ladder and `ask` cutoff

Start from the minimum step that answers the request; climb this ladder before opening sources.

1. Resume / active focus: `$CLI brief --mode resume` (read-only triage)
2. **Typical**: `$CLI ask "<question>"` — auto-escalation brief→evidence + auto-incrementing `--call-number` (no manual LLM annotation needed)
3. For fine control (e.g. changing neighbors): use primitives (`search` / `evidence`) directly

Read files surfaced by GraphRAG first; broaden only when `ask` results are insufficient. Do not mix graph-derived facts with speculation. Missing knowledge is a temporary investigation gap, not a new persistent node.

### Query discipline (dual-language keywords, `--gist`)

Search combines lexical + semantic (§Invariants #3), so **query vocabulary determines the hit surface**.

- **Include both natural-language and code-language terms.** Knowledge is distilled in natural language (e.g. "duplicate detection") while code uses English identifiers (e.g. `duplicate_check`). Using only one narrows the surface. Even in a casual Japanese query, adding 1–2 code terms helps both channels (e.g.: `ask "重複ノードを弾く duplicate_check の仕組み"`).
- **Use `--gist "<expected one-liner>"` for multi-query.** When the question alone is hard to hit, add the expected answer as `--gist` — it embeds question and gist separately and matches against both.
  - Example: `ask "なぜ vault を単一正本にした" --gist "graph.json は索引器の中間表現であって正本ではない"`
- **`--graph-rerank on|off`** (default off; hub-biased net-negative; consider on only for balanced island-structure graphs).

### Stacking aliases (giving knowledge nodes alternate names)

Node `aliases: string[]` is wired to embedding and lexical **aliasExact** (exact match on alias) — **aliasExact is the strongest lexical signal**. Add aliases via `--aliases "a,b,c"` (comma-separated, available on all typed-add verbs) for nodes you want to be easily retrievable. Include both natural-language and code-language terms.

### Cutoff judgment (reading `ask` output)

- If auto-escalation reaches `evidence` and returns empty, the knowledge truly does not exist. **Try one different keyword only.** Do not repeat.
- `repeat_state: excessive` (call_number ≥ 3) → **stop graph search, switch to code / doc direct reading.**
- Match `state_note` (e.g. `"superseded — check refines reverse for successor"`) → follow the note, prefer successor/active nodes.
- **`cross_vault_resolved`** — when a matched node's edges point to another vault, `ask` resolves the target node's title/summary and attaches it inline. If title/summary is insufficient, follow the pointer by running `$CLI ask "<question>" --vault <path>` against the target vault. This is a graph-structural pointer traversal, not a heuristic search — follow it proactively. Typical case: a project vault Goal/Task references a system vault Deliverable via cross-vault ref.
- Full field reference: `$REF/ask-output-guide.md`.

## Recipe

| Goal | Command |
|---|---|
| Answer a vague question comprehensively | `$CLI ask "<question>"` |
| Persist a single Decision | `$CLI add-decision --system <s> --slug <slug> --title "..." --summary "..." --evidence file:<s>:<path>` |
| Record a failed attempt | `$CLI add-rejected-option --system <s> --slug <slug> --title "<tried approach>" --summary "<failure mode>" --rejected-in-favor-of decision:<s>:<chosen>` |
| Record operational knowledge | `$CLI add-ok --system <s> --slug <slug> --title "..." --summary "..." --evidence file:<s>:<path>` |
| Record a risk | `$CLI add-risk --system <s> --slug <slug> --title "..." --summary "..." --evidence file:<s>:<path>` |
| Record an investigation episode | `$CLI add-investigation --system <s> --slug <slug> --title "..." --summary "..." --raw-content "key commits:\n- 2026-MM-DD <hash> <subject>"` |
| Record a constraint (invariant) | `$CLI add-constraint --system <s> --slug <slug> --title "..." --summary "..." --constrains <id,...>` (`--constrains` required ≥1, target Decision\|File\|OK) |
| Record a goal | `$CLI add-goal --system <s> --slug <slug> --title "..." --summary "..." [--refines <goal-id>] [--state planned\|active\|achieved\|abandoned]` |
| Apply a complex plan (validated write to vault) | `$CLI commit-mutation <plan.json>` |
| Initial indexing + concept extraction + quality gate | `$CLI carve --root <repo> --system <name>` (see `$REF/indexing-and-carving.md`) |
| Check status (env / artifacts) | `$CLI inspect` |

`--evidence` is required by schema for `add-*` (Decision/RejectedOption/Risk/OK without source backing get validation-rejected). Provide at least one `file:<system>:<path>`. **Exceptions**: `add-constraint` takes no evidence — requires `--constrains <id,...>` (target Decision|File|OK, ≥1) instead. `add-goal` also needs no evidence.

All typed-add verbs can attach edges via flags. Key ones:

- `add-decision`: `[--sets-policy-for <id,...>]` / `[--premise <id,...>]` / `[--from-investigation <id>]` (led_to) / `[--refines <decision-id>]` / `[--reduces-risk <risk-id,...>]`
- `add-ok`: `[--premise <id,...>]` / `[--refines <id>]` / `[--reduces-risk <id,...>]`
- `add-risk`: `[--risks-in <id,...>]`
- `add-constraint`: `--constrains <id,...>` (required ≥1)
- `add-goal`: `[--refines <goal-id>]` / `[--derived-from <id>]` / `[--state planned|active|achieved|abandoned]`
- All verbs: `[--aliases "a,b,c"]` / `[--description "..."]` / `[--dup-ack <id[,id...]>]`

## Headline verbs (chained, multi-stage in one command)

- `ask "<q>"` — auto-escalation brief→search→evidence + auto-incrementing `--call-number` (reads vault)
- `carve --root <repo> --system <name>` — index → concern-hint → policy-suggest → carving-check chain. **Post-index, File and Component/Layer candidate summaries are machine templates (`summary_provisional`). You must read them and rewrite to meaningful summaries, then remove `summary_provisional`** (leaving it causes concern-hint rejection / carving-check ERROR). **Concern (crosscut) discovery is driven by LLM conceptual modeling** — concern-hint machine candidates (for Concern discovery) are for blind-spot checking only (`$REF/conceptual-pass.md` §2).
- `commit-mutation <plan.json>` — **via vault writer** (lock → OCC → vault import → normalize/validate → atomic delta write → vector-index update (non-fatal) → git commit). Failure is all-or-nothing rollback.
- `add-decision` / `add-ok` / `add-risk` / `add-investigation` / `add-rejected-option` / `add-constraint` / `add-goal` — builds plan from args + applies to **vault**. Use `--dup-ack <id[,id...]>` to pass duplicate gate suspects.
- `inspect` — status of env + artifacts (vault / graph.json / vector-index / world) as single JSON

## Primitive verbs (per-stage, fine-grained control)

Headline = multi-stage sugar (quick/typical). Primitive = direct per-stage control. No hierarchy — choose by control granularity. Flag details: `$REF/cli-primitives.md`.

| verb | role |
|---|---|
| `brief` | summary response (resume / query mode, reads vault) |
| `search` | ranked neighbor expansion (reads vault) |
| `evidence` | provenance-attached answer packet (reads vault) |
| `index` | deterministic indexing (git ls-files + role classification + deps) → graph.json |
| `vector-index` | build vector index (from vault) |
| `vault-build` | graph.json → vault (**empty-vault initial build only**; wipes & rebuilds. Guarded: refuses if the existing vault holds nodes absent from the source graph, since those non-indexed knowledge nodes would be lost. `--force` to override) |
| `vault-import` | vault → graph.json (for round-trip verification) |
| `concern-hint` | machine hints for Concerns (embedding proximity clustering). For blind-spot checking after LLM modeling |
| `edge-suggest-policy` | sets_policy_for candidate extraction |
| `carving-check` | carving quality gate |
| `branch-merge` | semantic merge analysis of vault git branches (read-only). Procedure: `$REF/branch-merge.md` |
| `world-join` | join a world: add this vault to world.json + write `GRAPHRAG_WORLD_DIR` to `.graphrag/.env`. Flags: `--world <dir>` `--vault <dir>` |
| `world-refresh` | rebuild cross-vault world-cache. When `GRAPHRAG_WORLD_DIR` is set, `ask` includes `world_hints` |
| `carving-allow` | manage `.graphrag/carving.json` (carving exemptions): `add` / `remove` / `list` / `migrate` |
| `harvest-history` | deterministic extraction from git history (no writes): reverts → RejectedOption candidates, HACK/FIXME markers → OK/Risk candidates |
| `staleness-check` | count commits since `generated_at` for files linked via documented_by/sets_policy_for/constrains, list candidates above threshold (read-only) |

## Parallel work and semantic merge (vault branch)

Parallel knowledge graph work is isolated via **vault git branches**; merging uses **per-node/edge semantic analysis**, not git's file-level merge (git misses rephrased duplicates, lineage-free Decision collisions, semantically contradictory edges). `branch-merge --branch <ref>` produces a judgment packet (JSON) from the 3-state diff (fork point / branch / main), read-only. Resolution: LLM reads the packet, composes the merged state as a mutation plan, and applies via `commit-mutation` to main's vault. Full procedure: `$REF/branch-merge.md`.

## Schema quick-reference

`graphrag/schema.ts` が正本。2つのプリセット: **system** (13ノード型/14エッジ型, 既定) と **project** (16ノード型/22エッジ型, `schema: project` で選択)。vault の VAULT.md frontmatter `schema` フィールドでプリセットが決まる。**`inspect` で vault type を確認し、type に応じた quickref を読むこと**: system → `$REF/schema-quickref-system.md`、project → `$REF/schema-quickref-project.md`。両方を同時に読まない。project vault の初期構築: `graphrag-project-init` スキル参照。**Judgment criterion: chose from alternatives → Decision; learned from operation → OperationalKnowledge. When unsure, use Decision.**

## Mutation Plan

```typescript
{
  reason: string,                   // required — why this mutation
  nodes: Array<{ op: "create"|"update"|"delete", id, type?, title?, summary?, description?, raw_content?, updates? }>,
  edges: Array<{ op: "create"|"delete", id, type, from, to }>,
  duplicate_ack?: string[]          // only when acknowledging duplicate gate suspects (existing node ids)
}
```

- Passing `null` as an `updates` value **deletes that field** (e.g. `{ "state": null }` to withdraw state).
- `summary` = one-line headline (stays in frontmatter, primary search carrier).
- `description` = distilled prose about the node (appears in vault body `## 説明` with round-trip marker, also enters embedding). **Write for every node in principle.** Guidelines:
  - **Aggregate types (especially Concern)**: not a list of constituents, but **what the collection means as a whole** — the meaning that emerges only at the aggregate level.
  - **Judgment types (Decision/Risk/Constraint/RejectedOption/OperationalKnowledge)**: **why it was decided that way**.
- `raw_content` = raw primary information (conversation logs, how it was decided, Slack URLs, etc.). **Do not discard even for judgment types**: low volume, becomes the primary source for tracing "why" later.

`commit-mutation` (and typed-add) enforce `validateGraph` passage (rejects unknown types, disallowed pairs, missing evidence, duplicate ids, state vocabulary violations).

| Goal | Recommended method |
|---|---|
| Single new Decision/OK/Risk/Investigation/RejectedOption/Goal/Constraint | typed-add (`add-*`) — no JSON needed |
| New Concern/Layer/Component, Update, Delete, policy reversal | `commit-mutation <plan.json>` — templates: `$REF/mutation-templates.md` |

### Write-time duplicate gate (duplicate_check)

The vault writer runs an embedding duplicate gate (cosine 0.92, same-type) on op:create. To acknowledge suspects as intentionally distinct, use `--dup-ack <id,...>`. The gate is a last resort — it does NOT replace `ask`-based pre-verification (§Anti-patterns). Mechanism details: `$REF/mutation-templates.md`.

## What to persist / When the LLM proactively writes

Only persist conclusions, constraints, risks, and operational knowledge that will be reused across sessions. Confine in-progress trial-and-error to `raw_content`.

### Proactive Persistence

Do not wait for the user to say "remember this." Write via `add-*` immediately when the following language markers **or actions** appear. Always run duplicate check (`ask` / `brief`) **first** (§Anti-patterns).

- **Implementation/fix/improvement/refactor reached a milestone (action trigger)**: just before committing or after finishing changes and reporting to user. Write back the underlying adoption decision, rejected alternatives, risks encountered, operational gotchas. **This is a silent action — actively watch for it** (easier to miss than verbal markers).
  → `add-decision` / `add-rejected-option` / `add-risk` / `add-ok` (whichever applies)
- **User states a conclusion**: "we'll go with X", "X is not an option", "X doesn't work", "from now on, Y"
  → `add-decision` / `add-rejected-option` / `add-risk` (whichever applies)
- **LLM itself states a conclusion**: "we should X", "avoid Y" in future tense
  → same as above
- **A substantive failed attempt (= RejectedOption + optionally Investigation)**:
  "tried approach X, hit constraint Y, had to retreat." **Capture this especially** — the #1 type that leaves no trace outside source code; not writing it means repeating the same failure.
  → `add-rejected-option --title "<tried approach>" --summary "<failure mode>" --rejected-in-favor-of <chosen Decision id>`
  → if the story spans multiple events, also `add-investigation` and connect via led_to

### Vault isolation guard

Write policy for external vaults is governed by `GRAPHRAG_VAULT_MODE` (§Setup). When unset, the CLI hard-errors and forces user confirmation.

### Write output suggestions

Post-write `suggestions` (binding/relations/led_to/premise_candidates/binding_debt) are all suggest-only and non-fatal. Judge and confirm, or decline with a reason. Edges are never auto-wired. Details: `$REF/mutation-templates.md` §suggestions.

### What NOT to persist

- Session-local exploratory notes
- Trivial scratch (variable renames, temporary lint fixes, etc.)
- Ad-hoc observations not stated in future tense

## Topology Gap Review

When a bug or oversight is found, ask: "could this have been prevented if the graph had the right structure?" If yes, add the missing Concern/Component + edges via `commit-mutation` (topology cultivation). Details: `$REF/topology-gap-review.md`.

## Drift Reconciliation (incidentally noticed divergence)

Only applies when you've retrieved the relevant node via GraphRAG AND read the corresponding code in the same context. Even if you notice "graph description ≠ current source," do NOT auto-fix (high false-positive risk without full investigation; wrong update/delete destroys information). Present to user in structured format (`[u]pdate / [d]elete / [s]kip / [i]nvestigate` — 4 choices) and apply via `commit-mutation` after their ruling. Format details: `$REF/drift-reconciliation.md`. Systematic drift audits are separate — only on explicit user request.

## Reporting format (user-facing)

Report graph changes in natural language (what knowledge changed / what relationships were connected / why it was kept / verification status). Do not dump node IDs / edge IDs / raw `commit-mutation` JSON output to the user — demote IDs to parenthetical references. Reports must connect to "so, what do we do next?"

## Reference links

- `$REF/cli-primitives.md`: full flag reference for all primitives
- `$REF/mutation-templates.md`: plan templates for Concern / Layer / Component / Update / Delete / policy reversal + suggestions details
- `$REF/schema-quickref.md`: **ルーター** — vault type を見て system/project の適切な quickref に誘導
- `$REF/schema-quickref-system.md`: system preset (13+14) / allowed pairs / state vocabulary / policy-reversal recipe
- `$REF/schema-quickref-project.md`: project preset (16+22) / allowed pairs / state vocabulary / cross-vault ref / 判断基準
- `$REF/ask-output-guide.md`: detailed ask output field guide (match_confidence / repeat_state / world_hints / standout)
- `$REF/topology-gap-review.md`: graph structure self-reflection protocol on bug discovery
- `$REF/branch-merge.md`: semantic merge procedure for vault branches
- `$REF/drift-reconciliation.md`: drift presentation format and post-ruling application
- `$REF/port-site.md`: porting reference only (env / escalation / graphName / output paths)
- `$REF/indexing-and-carving.md`: **must read for initial indexing and conceptual pass**
- `$REF/carving-rationale.md`: core value of 12 node types + edge grammar, RejectedOption as first-class, Layer≠Concern≠Component
- `$REF/interpretation-guidance.md`: universal guidance for File interpretation summaries (primary lever for retrieval quality)
- `$REF/conceptual-pass.md`: conceptual interpretation pass procedure
- `$REF/carving-rules.md`: carving quality guards (no sequential slugs / completeness / duplicate detection / automated verification commands)
- `$REF/indexer-redesign-notes.md`: indexer essence, redesign guidelines, capability eval
