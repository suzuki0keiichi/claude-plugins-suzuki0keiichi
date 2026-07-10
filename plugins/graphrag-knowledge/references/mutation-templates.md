# Mutation Plan Templates

These plans are validated and applied **to the vault** via `node graphrag/cli.ts commit-mutation <plan.json>` (the vault is the single source of truth; the only write paths are commit-mutation / add-*).

> **About `<system>` in ids**: the `<system>` in the id convention `<typeSlug>:<system>:<slug>` is a namespace label.
> No edge to express membership is needed (contains was removed in v3.3; membership is carried by the vault's existence and the id convention).

The frequent cases covered by typed-add (`add-decision` / `add-ok` / `add-risk` / `add-investigation` / `add-rejected-option` /
`add-goal` / `add-constraint`) need only CLI arguments, so this template is unnecessary for them.
**Goal / Constraint are now covered by `add-goal` / `add-constraint` too** (edges are wired with flags like `--refines` /
`--constrains`; SKILL.md §Recipe). The Goal / Constraint templates below remain
for complex cases that assemble multiple nodes/edges at once. The remaining **Concern (crosscut)** and
**Update / Delete / policy-reversal** families are not in typed-add, so use this template for them.

---

## Concern (crosscut, points at multiple Files via evidenced_by)

A crosscutting concern that runs across Layers and Components. The only edge is evidenced_by.

```json
{
  "reason": "新規 Concern <slug>",
  "nodes": [
    { "op": "create", "id": "concern:<system>:<slug>", "type": "Concern", "title": "...", "summary": "...",
      "description": "(任意) 蒸留散文。この関心が何を/なぜ横断するか。vault body `## 説明` に出る" }
  ],
  "edges": [
    { "op": "create", "id": "concern_<slug>__evidenced_by__file_<file_a_slug>",
      "type": "evidenced_by", "from": "concern:<system>:<slug>", "to": "file:<system>:<pathA>" },
    { "op": "create", "id": "concern_<slug>__evidenced_by__file_<file_b_slug>",
      "type": "evidenced_by", "from": "concern:<system>:<slug>", "to": "file:<system>:<pathB>" }
  ]
}
```

- `evidenced_by` is Concern → File (in schema `[ANY_CROSSCUT_NODE, "File"]`, ANY_CROSSCUT = Layer/Concern/Component). Manual creation of `Layer` / `Component` has the same shape (grounded to File via evidenced_by).
- Typically bundles about 2-5 Files. If it would connect only 1 File, do not make it a Concern — just write it into that File's summary.
- **`summary` vs `description`**: `summary` = one-line headline (frontmatter, primary search carrier). `description` = distilled prose, **written for every node in principle** (appears in the vault body as `## 説明` with a round-trip marker, and also enters the embedding). For aggregate types (Concern etc. especially matter) write "what the collection ultimately is = the true nature of the *what*", not a list of constituents; for judgment types (Decision/Risk/Constraint/RejectedOption/OperationalKnowledge) write "why it was decided that way". Do not discard judgment types' raw information (conversation logs, Slack URLs, etc.) — keep it as source backing in `raw_content` or in a ConversationChunk/Investigation that holds raw_content. Omit `description` only when it would be a mere copy of the summary (when empty, no `## 説明` appears in the body). Goal / Constraint have the same shape. It can also be given via `--description "..."` in typed-add (`add-*`).

## Goal (the system's final cause / target state; absorbs v2's Requirement)

> A single Goal is covered by `add-goal --system <s> --slug <slug> --title "..." --summary "..." [--refines <goal-id>] [--state planned|active|achieved|abandoned] [--derived-from <id>]`. The template below is for assembling multiple nodes at once.

Goals relate to each other via `refines`; connection to grounds is via `derived_from` / `has_premise` (details in SKILL.md's schema quick-ref).

```json
{
  "reason": "新規 Goal <slug>",
  "nodes": [
    { "op": "create", "id": "goal:<system>:<slug>", "type": "Goal", "title": "...", "summary": "..." }
  ],
  "edges": [
    { "op": "create", "id": "goal_<slug>__refines__goal_<parent_slug>",
      "type": "refines", "from": "goal:<system>:<slug>", "to": "goal:<system>:<parent_slug>" }
  ]
}
```

- If there is no parent Goal, `edges` may be empty. To ground it in the originating conversation/investigation, add `Goal -derived_from-> ConversationChunk|Investigation`.

## Constraint (constraint, points at its target via constrains)

> A single Constraint is covered by `add-constraint --system <s> --slug <slug> --title "..." --summary "..." --constrains <id,...>` (`--constrains` required ≥1, target Decision|File|OK). Constraint disallows documented_by and needs no evidence. The template below is for assembling multiple constrains at once.

```json
{
  "reason": "新規 Constraint <slug>",
  "nodes": [
    { "op": "create", "id": "constraint:<system>:<slug>", "type": "Constraint", "title": "...", "summary": "..." }
  ],
  "edges": [
    { "op": "create", "id": "constraint_<slug>__constrains__file_<file_slug>",
      "type": "constrains", "from": "constraint:<system>:<slug>", "to": "file:<system>:<path>" }
  ]
}
```

- `constrains`: Constraint → Decision / File / OperationalKnowledge.
- Show "what this constraint binds" with one or more constrains (a specific Decision / a specific File / a specific OK). A norm that applies to the whole vault goes in CLAUDE.md / AGENTS.md, not the graph.

## Update (change the description of an existing node)

`type` / `from` / `to` are immutable. Only patches to `summary` / `description` / `raw_content` etc.
**Passing `null` as an `updates` value deletes that field itself** (e.g. `{ "state": null }` withdraws the state). No `null` ever remains in the graph or frontmatter.

```json
{
  "reason": "<対象> の summary を最新の合意に合わせる",
  "nodes": [
    {
      "op": "update",
      "id": "decision:<system>:<slug>",
      "updates": { "summary": "<新しい summary>" }
    }
  ],
  "edges": []
}
```

## Delete (remove a node; touching edges cascade)

```json
{
  "reason": "<理由>",
  "nodes": [
    { "op": "delete", "id": "decision:<system>:<slug>" }
  ],
  "edges": []
}
```

The cascaded edge IDs can be checked in `summary.cascaded_edge_ids` of the `commit-mutation` output.

## Policy reversal (overturn a Decision; the supersedes grammar is unchanged)

Create a new Decision, (1) wire `refines`: new→old, and (2) set the old Decision to `state: "superseded"` via op:update. `supersedes` stays Decision|OK → RejectedOption — there is no grammar to wire it between Decisions. Incoming `has_premise` edges to the old node stay live (lineage preservation).

```json
{
  "reason": "方針転換: <旧方針> を <新方針> で置き換える",
  "nodes": [
    { "op": "create", "id": "decision:<system>:<new-slug>", "type": "Decision", "title": "...", "summary": "...",
      "description": "なぜ転換したか (旧方針の何が成り立たなくなったか)" },
    { "op": "update", "id": "decision:<system>:<old-slug>", "updates": { "state": "superseded" } }
  ],
  "edges": [
    { "op": "create", "id": "decision_<new-slug>__documented_by__file_<file_slug>",
      "type": "documented_by", "from": "decision:<system>:<new-slug>", "to": "file:<system>:<path>" },
    { "op": "create", "id": "decision_<new-slug>__refines__decision_<old-slug>",
      "type": "refines", "from": "decision:<system>:<new-slug>", "to": "decision:<system>:<old-slug>" }
  ]
}
```

- The new Decision also requires source backing (`documented_by` File, or `derived_from` to a ConversationChunk/Investigation with raw_content).
- **Only when the approach discarded by the reversal could tempt re-adoption**, create a new RejectedOption and add newDecision -`supersedes`-> it alongside (the RejectedOption also requires source backing):

```json
  { "op": "create", "id": "rejectedoption:<system>:<slug>", "type": "RejectedOption",
    "title": "<捨てた案>", "summary": "<なぜ再採用しないか>" }
```
```json
  { "op": "create", "id": "decision_<new-slug>__supersedes__rejectedoption_<slug>",
    "type": "supersedes", "from": "decision:<system>:<new-slug>", "to": "rejectedoption:<system>:<slug>" }
```

---

## Compaction checkpoint (bundles flush A + rescue B into one)

The batch plan that the `graphrag-checkpoint` skill fires just before compact. It applies **A (flushing the work state) and B (rescuing unwritten durable knowledge) as equals in a single plan**. Common to both presets (only the rescue-target knowledge types and the presence of Assumption/Agreement vary by preset).

Discipline:
- **The Investigation is one per focus, overwritten via `op:update` on a fixed slug** (op:update advances `generated_at` to now, so it comes to the front as the latest in `brief --mode resume`'s primary selection). Only the first time is `op:create` (`state: "active"`).
- Put the work state as structured text in the Investigation's **`raw_content`** (do not create a dedicated field). `brief --mode resume` surfaces it as `work_state`.
- Put deep raw logs in a **ConversationChunk** (update-in-place on a fixed slug, high-value fragments only), wired to the Investigation via `discussed_in`.
- Always connect a rescued knowledge node to the Investigation via **`derived_from` (knowledge→Investigation)** (so that restore reaches the actual node, not just the prose). Decisions additionally get **`led_to` (Investigation→Decision)**.
- **Do not write to plan/schedule types (Task/Milestone/Resource/Stakeholder).**

```json
{
  "reason": "compaction checkpoint: <focus の一言>",
  "nodes": [
    { "op": "update", "id": "investigation:<system>:<focus-slug>",
      "updates": { "raw_content": "current focus: <いま何を>\nnext: <次の具体手>\nblocker: <詰まり>\ntouched: <file:line ...>" } },
    { "op": "update", "id": "conversationchunk:<system>:<focus-slug>-scratch",
      "updates": { "raw_content": "<失敗した道 / 正確なコマンド / 非自明な発見 / このセッションのユーザ制約>" } },
    { "op": "create", "id": "decision:<system>:<slug>", "type": "Decision",
      "title": "<採用した判断>", "summary": "...", "description": "なぜそう決めたか" },
    { "op": "create", "id": "risk:<system>:<slug>", "type": "Risk",
      "title": "<気づいた脅威>", "summary": "...", "description": "なぜリスクか" }
  ],
  "edges": [
    { "op": "create", "id": "conversationchunk_<focus-slug>-scratch__discussed_in__investigation_<focus-slug>",
      "type": "discussed_in", "from": "conversationchunk:<system>:<focus-slug>-scratch", "to": "investigation:<system>:<focus-slug>" },
    { "op": "create", "id": "investigation_<focus-slug>__led_to__decision_<slug>",
      "type": "led_to", "from": "investigation:<system>:<focus-slug>", "to": "decision:<system>:<slug>" },
    { "op": "create", "id": "decision_<slug>__derived_from__investigation_<focus-slug>",
      "type": "derived_from", "from": "decision:<system>:<slug>", "to": "investigation:<system>:<focus-slug>" },
    { "op": "create", "id": "risk_<slug>__derived_from__investigation_<focus-slug>",
      "type": "derived_from", "from": "risk:<system>:<slug>", "to": "investigation:<system>:<focus-slug>" },
    { "op": "create", "id": "decision_<slug>__documented_by__file_<file_slug>",
      "type": "documented_by", "from": "decision:<system>:<slug>", "to": "file:<system>:<path>" }
  ]
}
```

- If the Investigation itself does not exist on the first run, make the first node `op:create` + `type: "Investigation"` + `state: "active"` + `title`/`summary`.
- The rescue is not necessarily one Decision and one Risk. **Sweep once per type** (Decision/RejectedOption/Risk/OperationalKnowledge, plus +Assumption/Agreement for project) and list **only the ones that do not exist** per the duplicate check — checkpoint's lightweight rule applies here: upfront `ask` only for candidates likely to predate the session, otherwise rely on the write-time duplicate gate (graphrag-checkpoint §B). Always attach `derived_from`→Investigation to each knowledge node.
- For flush only (zero rescue), it holds with nodes = the Investigation (+ConversationChunk) only, and edges = `discussed_in` only.

---

## Common plan shape

```typescript
{
  reason: string,                   // required — why this mutation
  nodes: Array<MutationNode>,       // op: create / update / delete
  edges: Array<MutationEdge>,       // op: create / delete (update usually unnecessary)
  duplicate_ack?: string[]          // only when acknowledging duplicate gate suspects (existing node ids)
}
```

`validateGraph` (schema.ts):
- rejects unknown node type / edge type (the old names Stratum/Vein/Pocket are normalized to Layer/Concern/Component via `canonicalType` and pass)
- rejects disallowed (from-type, to-type) combinations
- rejects Decision/RejectedOption/Risk/OperationalKnowledge without evidence backing (enforceSourceBacking)
- rejects duplicate create of the same id
- limits state to the per-type vocabulary (`STATE_VOCABULARY`): Investigation = active/closed, Decision/OperationalKnowledge = superseded only, Goal = planned/active/achieved/abandoned. state on any other type is rejected, as is an out-of-vocabulary value (no state is always legal)

In addition, the vault writer's validation stage has a **write-time duplicate gate** (`duplicate_check`): it checks op:create knowledge/crosscut nodes (everything except File and ConversationChunk = schema's duplicateCheck targets) against same-type existing nodes. Checking runs two paths — embedding cosine ≥ 0.92 (embedded in **document space**; using the same text composition and same prefix as the index row makes the calibration honest) and lexical (normalized title / alias exact match, similarity 1.0). A suspect is returned with its judgment material in the form `{new_id, existing_id, similarity, basis: "embedding"|"lexical", existing: {type,title,summary,state}, next_step}`. On a hit, it is rejected all-or-nothing unless `duplicate_ack` covers every suspect. From typed-add, inject via `--dup-ack <id[,id...]>`. An unreachable embedding endpoint / absent vector index is a non-fatal skip (the lexical pre-pass runs even when embedding is unreachable). The gate is the last net — pre-checking for duplicates with `ask` is still required.

The output carries advisory (never-rejecting) companion information:

- `cross_type_suspects`: cross-type duplicate suspicion (Decision↔OperationalKnowledge / Risk↔Constraint — only type groups whose boundary is fuzzy by design). Surfaces, as a suggestion, what the same-type filter structurally misses.
- `index_stale` + `index_stale_reason`: an honest declaration when the vector index is older than vault HEAD (the gate's net may be stale).
- `precheck: {recent_ask_hits, note}`: an observation that the ask-trail is empty when creating a knowledge node (= suspicion that the `ask` pre-check was skipped).

On error, `commit-mutation` (vault writer) throws an Error with a `failures` array and the vault is unchanged (all-or-nothing).

---

## Write output suggestions

After writing, `add-*` / `commit-mutation` attach a `suggestions` object to the output (all **suggest-only and non-fatal**; when the index / endpoint is absent, each suggestion is skipped empty with a reason, and the write is never stopped). **Judge and confirm a suggestion, or decline it with a reason. Nothing is wired automatically** — that is the boundary (edges are never auto-attached; confirmation is by the LLM/human).

- `suggestions.binding`: for the created Decision/OK/Risk/Constraint, binding candidates matched by embedding against Files in the vector index (per-type fixed: Decision→sets_policy_for / Risk→risks_in / OK→documented_by / Constraint→constrains). Each candidate carries `path` / `title` / `summary` (judgment material) and `similarity`, plus `apply.plan_fragment` (a commit-mutation fragment for the edge) → if valid, **paste plan_fragment straight into a commit-mutation plan's `edges` to confirm in one step**.
- `suggestions.relations`: relation candidates where same-type nodes' cosine is in the [0.80, 0.92) band (noted that which of refines / has_premise / supersede applies is **judged by the LLM**). Read the content and wire the applicable relation or decline.
- `suggestions.led_to`: on Decision creation, lists `state:"active"` Investigations in the graph → if the Decision was derived from that investigation, wire led_to.
- `suggestions.premise_candidates`: among the ask-trail's recent hits, those of type Decision/Constraint/Goal/OK → if a premise, wire has_premise.
- `suggestions.binding_debt`: the total count of unbound knowledge nodes (same definition as carving-check #9, including the Constraint extension) as a single integer. If it is rising, it is a sign that unlinked knowledge is piling up.

For all of them: "judge and confirm, or decline with a reason". Do not silently leave a suggestion as-is (if declining, be in a state where you can state the reason).

---

## Project Vault Templates (`schema: project`)

Project vaults use a different node/edge set from system vaults. The following templates show common patterns. For the full schema, see `$REF/schema-quickref-project.md`.

### Initial population (batch creation)

Typical initial setup for a project vault. Note: `Assumption` requires `certainty` field.

```json
{
  "reason": "Initial setup for <project name>",
  "nodes": [
    { "op": "create", "id": "goal:<sys>:main-objective", "type": "Goal",
      "title": "...", "summary": "...", "state": "active" },
    { "op": "create", "id": "milestone:<sys>:target-date", "type": "Milestone",
      "title": "...", "summary": "...", "state": "planned" },
    { "op": "create", "id": "assumption:<sys>:key-premise", "type": "Assumption",
      "title": "...", "summary": "...", "certainty": "Expected",
      "description": "Why this certainty level: ..." },
    { "op": "create", "id": "stakeholder:<sys>:lead", "type": "Stakeholder",
      "title": "...", "summary": "..." },
    { "op": "create", "id": "agreement:<sys>:partner-contract", "type": "Agreement",
      "title": "...", "summary": "...", "state": "active",
      "raw_content": "Contract details from source doc...",
      "raw_content_status": "copied_from_summary" },
    { "op": "create", "id": "task:<sys>:key-work", "type": "Task",
      "title": "...", "summary": "...", "state": "planned" },
    { "op": "create", "id": "resource:<sys>:shared-infra", "type": "Resource",
      "title": "...", "summary": "...",
      "description": "category: asset" },
    { "op": "create", "id": "source:<sys>:meeting-notes", "type": "Source",
      "title": "...", "summary": "...",
      "description": "url: https://...\nfetched_at: 2026-06-18\nsource_kind: document" }
  ],
  "edges": [
    { "op": "create", "id": "edge:goal-targets-milestone",
      "type": "targets", "from": "goal:<sys>:main-objective", "to": "milestone:<sys>:target-date" },
    { "op": "create", "id": "edge:goal-premise-assumption",
      "type": "has_premise", "from": "goal:<sys>:main-objective", "to": "assumption:<sys>:key-premise" },
    { "op": "create", "id": "edge:task-achieves-goal",
      "type": "achieves", "from": "task:<sys>:key-work", "to": "goal:<sys>:main-objective" },
    { "op": "create", "id": "edge:task-requires-resource",
      "type": "requires", "from": "task:<sys>:key-work", "to": "resource:<sys>:shared-infra" },
    { "op": "create", "id": "edge:stakeholder-responsible",
      "type": "responsible_for", "from": "stakeholder:<sys>:lead", "to": "task:<sys>:key-work" },
    { "op": "create", "id": "edge:stakeholder-party",
      "type": "party_to", "from": "stakeholder:<sys>:lead", "to": "agreement:<sys>:partner-contract" },
    { "op": "create", "id": "edge:agreement-derived",
      "type": "derived_from", "from": "agreement:<sys>:partner-contract", "to": "source:<sys>:meeting-notes" }
  ]
}
```

**Source backing for Agreement**: `Agreement` → `derived_from` → `Source` is the standard pattern. When `derived_from` type pairs don't allow direct linking, use `raw_content` + `raw_content_status: copied_from_summary` on the Agreement node itself as a workaround.

### Cross-vault ref (referencing system vault Deliverables)

```json
{
  "reason": "Wire cross-vault dependency to system vault Deliverable",
  "nodes": [],
  "edges": [
    { "op": "create", "id": "edge:task-requires-deliverable",
      "type": "requires",
      "from": "task:<sys>:integration-work",
      "to": "vault:<system-vault-slug>/deliverable:<system>:<slug>" }
  ]
}
```

The `vault:` prefix in `to` skips local existence and type-pair checks. The target Deliverable must exist in the referenced system vault (create thin stubs in Step 0 if needed).

### Theme (cross-project concern)

```json
{
  "reason": "Add cross-project theme",
  "nodes": [
    { "op": "create", "id": "theme:<sys>:shared-concern", "type": "Theme",
      "title": "...", "summary": "...",
      "description": "Why this is a cross-project concern, not just a local edge" }
  ],
  "edges": [
    { "op": "create", "id": "edge:theme-encompasses-goal",
      "type": "encompasses", "from": "theme:<sys>:shared-concern", "to": "goal:<sys>:affected-goal" },
    { "op": "create", "id": "edge:theme-encompasses-risk",
      "type": "encompasses", "from": "theme:<sys>:shared-concern", "to": "risk:<sys>:related-risk" },
    { "op": "create", "id": "edge:theme-encompasses-assumption",
      "type": "encompasses", "from": "theme:<sys>:shared-concern", "to": "assumption:<sys>:shared-premise" }
  ]
}
```

### Agreement state transition (no backward transitions)

```json
{
  "reason": "Negotiation failed, restart with new terms",
  "nodes": [
    { "op": "update", "id": "agreement:<sys>:old-deal",
      "updates": { "state": "expired" } },
    { "op": "create", "id": "agreement:<sys>:new-deal", "type": "Agreement",
      "title": "...", "summary": "Renegotiated terms after ...", "state": "exploring",
      "raw_content": "...", "raw_content_status": "copied_from_summary" }
  ],
  "edges": []
}
```

Do NOT reverse state (e.g. `negotiating` → `exploring`). Expire the old, create a new one.
