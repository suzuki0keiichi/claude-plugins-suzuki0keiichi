# ask Output Field Guide

Details of the fields in `ask`'s output. Behavioral rules (repeat suppression, cutoff judgment) are in SKILL.md "Retrieval ladder and `ask` cutoff".

Common principle: null / missing fields are not emitted (no filler like `path: null`). Read an absent key as "that attribute is absent".

## `final_stage`

`brief` / `evidence` — how far it auto-escalated. If brief's confidence is high and there are matches, it stops at `brief`; otherwise it auto-digs down to evidence. If `direct_evidence` is empty at `evidence`, it truly does not exist.

## `next_action_hint`

Computed from the **final stage**'s result (if brief sufficed, brief's; if it dug down to evidence, evidence's confidence/count). Wording ready to relay to the user as the explanation (translate into the conversation language when relaying).

## `area_map` — the registered structure of the area you are about to touch

Rides along on **every** ask (computed from the hit set: matched Files + Files located by matched knowledge nodes' `documented_by`/`sets_policy_for`/`constrains`/`enforced_by`/`risks_in` edges). This is the design-time reference the crosscut layer exists for — **consult it before choosing where new code lives**; do not fire an extra ask for it.

- `crosscuts[]` — Component/Layer/Concern covering the area: `{id, type, title, summary, generated_at?, files_in_scope, files_total, matched_directly?}`, sorted by relevance, capped at 8. `summary` is the full registered intent, including any final conditions; JSON and `--format md` carry the same structural summaries. `matched_directly` marks structure nodes that themselves matched the query. A direct structure match does not expand scope to all its members.
- `crosscuts_overflow` — how many additional structures were omitted by the 8-node cap. For a complete concrete file scope, use `delta-check --files <paths> --full`.
- `summary_provisional: true` marks an indexer scaffold, not authored intent. The raw summary stays visible with that flag (and a provisional label in markdown); do not treat it as a norm. An empty summary is also unavailable intent, not an omitted body that another lookup can recover.
- `unframed_files[]` — scope Files belonging to no crosscut (capped; `unframed_overflow` counts the rest). **Not a verdict** — small clusters legitimately have no Component.
- `note` — how to read the map. Empty `crosscuts` means none was reached from this search scope, not that the whole change has no structure. Missing/old summaries are not a clean bill of health: compare the actual change with the registered intent, and distinguish unverified scope from conformance.
- Placement rules of thumb: new code that belongs to a listed frame goes inside it (wire via `evidenced_by`); a genuinely new concept deserves its own registration instead of squatting. Per-path claimant lookup and paste-ready wiring fragments: `frame-check`.

## `enforcement_debt` (only when > 0, system vaults)

Migration rail for vaults written before the enforcement contract: when the vault holds Constraints with neither an `enforced_by` edge nor an `enforcement:"none"` declaration, every ask carries `{unguarded_constraints, constraints_total, hint}`. **Relay this to the user once per session** — those constraints enforce nothing until wired. The prescription lives in `constraint-check` (per-constraint next_step + paste-ready plan_fragment). Absent key = no debt.

## `stages[*].output.query.match_confidence`

- `high` + matches present → adopt; it has stopped at `final_stage: brief`
- `low` / `none` / empty matches → the launcher has already escalated to evidence. If still empty, **try a different keyword exactly once** (keyword change is the LLM's responsibility). Do not repeat.

Breakdown of the judgment: vector and lexical (alias exact match / coverage / ngram) are scored independently and the stronger is taken. Vector is judged by the **corpus-relative margin** from the index meta's `noise_baseline` (stamped at index build, the cosine distribution of random node pairs) — because absolute cosine is model-dependent and meaningless. On an old index without a baseline, it falls back to provisional absolute-value bands (rebuilding the index makes it a relative judgment).

## `stages[*].output.query.standout` / the evidence packet's `standout`

The same relative judgment as world_hints, applied to the local vault's matches too.

- `state`: `clear` = top1 stands out from the other candidates (relative gap ≥ 0.30; if not high, it has been promoted one level) / `none` = level pegging / `single` = one or fewer candidates, no relative judgment
- `gap_above_next`: (top1 − top2) / top1, the relative gap (the basis)

## `type_word_divergence` (only when the question contains node-type names)

When the question contains node-type names (`Decision`, `Constraint`, ...), `ask` also runs the question with those words removed (same `--types` / `--gist` / `--lexical-only`) and compares the top match. Type names are scored as ordinary words in both lexical and semantic matching, so they can push up nodes that merely mention the type.

- Absent = no type names, or both versions agree on the top match (output unchanged).
- `status: "diverged"` — the top match changed. Confidence is capped below `high`, and a `high` brief is not escalated to evidence (evidence would dig with the same distorted question). `stripped_top` lists the type-word-free candidates. Decide by meaning: if the type names are a filter ("the Decision about X"), follow `next_action_hint` and re-run `ask "<stripped_query>" --types <types>`; if the question is about the types themselves ("Risk vs Decision"), read the original matches. Neither is chosen automatically.
- `status: "unavailable"` + `reason` — the comparison could not run; confidence is capped the same way.
- Agreement is not proof of correctness: both versions can agree on the same wrong node.

## `stages[*].output.query.repeat.repeat_state`

- `excessive` (call_number ≥ 3) → **stop graph search and move to reading code / docs directly**. `--call-number` is auto-incremented by the launcher, so no LLM self-reporting is needed.

## a match's `state` / `state_note`

Nodes whose state is superseded/closed/abandoned/achieved are penalized to 0.6x their ranking score (not excluded = the no-hard-reject principle). A penalized match gets a `state_note` (e.g. `"superseded — check refines reverse for successor"`), so follow the note and prefer the successor/live node.

## a match's `relations` (brief)

Up to 8, in edge-type priority order (supersedes / refines / has_premise / sets_policy_for / constrains first, discussed_in / documented_by last). Three shapes:

- `{relation, direction, node: {...}}` — first appearance of a node. With details (summary shortened to ~120 chars)
- `{relation, direction, id}` — second and later appearances. For details see the first appearance or `matches[*].node` (the same node is not dumped twice)
- `{relation, direction, to: "vault:<slug>/<nodeId>"}` — an unresolved cross-vault reference stub. When `GRAPHRAG_WORLD_DIR` is set, the resolution result is attached in `cross_vault_resolved`

## evidence packet (`stages[*].output`, when final_stage is evidence)

- `direct_evidence[*]` — ranked matches. `node` is full text (whichever of id/type/title/summary/path/state/provenance/short_label/display/aliases is present). **Use this first**.
- `graph_context` — the neighbor-expansion context. For supporting context only:
  - `graph_context.nodes` — **a table keyed by id**. Values are `{type, title?, summary?(~140 chars), path?, state?}`. The same node appears only once. Match nodes whose full text appeared in direct_evidence are not repeated (pull the id from edges). "What is this id" can be checked in this table (no re-query needed).
  - `graph_context.edges[*]` — `{depth, relation, from, to}` (from/to are id references). Neighbor expansion is truncated at ~10 edges per node (in edge-type priority order) / ~40 overall. Endpoints of `vault:` references are not in the nodes table and stay as id references.
- `standout` — the same relative judgment as above.
- `answer_instructions` — a one-line summary + a pointer to this guide.

## `cross_vault_resolved` (`GRAPHRAG_WORLD_DIR` only)

When a matched node's edges (relations) contain a cross-vault ref (`vault:<slug>/<nodeId>`), `ask` resolves the target node's title/summary from the referenced vault and attaches it inline.

- `cross_vault_resolved[*].ref` — original cross-vault ref string (e.g. `"vault:billing/deliverable:billing:v2-release"`)
- `cross_vault_resolved[*].edge_type` — edge type (e.g. `"has_premise"`)
- `cross_vault_resolved[*].resolved` — resolved node's title/summary. `null` means resolution failed (vault absent or node not found).

**Action**: if title/summary suffices, no further ask needed. If deeper context is required, follow the pointer by running `ask "<question>" --vault <path>` against the target vault. This is a graph-structural pointer traversal, not a heuristic search — follow it proactively.

## `world_hints` (only when `GRAPHRAG_WORLD_DIR` is set)

Hints that "vault X probably also has knowledge".

- When `hints[*].confidence` is `high` and the local `match_confidence` is weak, consider running `hints[*].ask_command` (= `ask "<question>" --vault <path>`) to query the outside vault. Whether to run it is the caller's (LLM's) judgment — it does not run automatically.
- `freshness.state: stale` is an honest declaration that the copy is old (with fetch time).
- `standout` is a relative judgment: `clear` = top1 stands out from the other candidates (likely a question specific to that vault's domain), `crowd` = candidates level pegging (either it truly relates to several, or it is nowhere — look at this before chasing every low hint), `single` = one candidate, no relative judgment. A top1 that stands out is promoted to high even if its absolute value is low (`gap_above_next` is the basis).
