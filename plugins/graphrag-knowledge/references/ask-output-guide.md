# ask Output Field Guide

Details of the fields in `ask`'s output. Behavioral rules (repeat suppression, cutoff judgment) are in SKILL.md "Retrieval ladder and `ask` cutoff".

Common principle: null / missing fields are not emitted (no filler like `path: null`). Read an absent key as "that attribute is absent".

## `final_stage`

`brief` / `evidence` — how far it auto-escalated. If brief's confidence is high and there are matches, it stops at `brief`; otherwise it auto-digs down to evidence. If `direct_evidence` is empty at `evidence`, it truly does not exist.

## `next_action_hint`

Computed from the **final stage**'s result (if brief sufficed, brief's; if it dug down to evidence, evidence's confidence/count). Wording usable as-is as a user-facing explanation.

## `stages[*].output.query.match_confidence`

- `high` + matches present → adopt; it has stopped at `final_stage: brief`
- `low` / `none` / empty matches → the launcher has already escalated to evidence. If still empty, **try a different keyword exactly once** (keyword change is the LLM's responsibility). Do not repeat.

Breakdown of the judgment: vector and lexical (alias exact match / coverage / ngram) are scored independently and the stronger is taken. Vector is judged by the **corpus-relative margin** from the index meta's `noise_baseline` (stamped at index build, the cosine distribution of random node pairs) — because absolute cosine is model-dependent and meaningless. On an old index without a baseline, it falls back to provisional absolute-value bands (rebuilding the index makes it a relative judgment).

## `stages[*].output.query.standout` / the evidence packet's `standout`

The same relative judgment as world_hints, applied to the local vault's matches too.

- `state`: `clear` = top1 stands out from the other candidates (relative gap ≥ 0.30; if not high, it has been promoted one level) / `none` = level pegging / `single` = one or fewer candidates, no relative judgment
- `gap_above_next`: (top1 − top2) / top1, the relative gap (the basis)

## `stages[*].output.query.repeat.repeat_state`

- `excessive` (call_number ≥ 3) → **stop graph search and move to reading code / docs directly**. `--call-number` is auto-incremented by the launcher, so no LLM self-reporting is needed.

## a match's `state` / `state_note`

Nodes whose state is superseded/closed/abandoned/achieved are penalized to 0.6x their ranking score (not excluded = the no-hard-reject principle). A penalized match gets a `state_note` (e.g. `"superseded — refines 逆引きで後継を確認"`), so follow the note and prefer the successor/live node.

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
