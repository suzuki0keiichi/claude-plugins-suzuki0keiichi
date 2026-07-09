# Conceptual pass — schema-legal mapping (general)

The exact procedure for the LLM to layer concepts, architecture, and history on top of
the indexer's deterministic scaffold. Applies to any repository. Do not add new edge/node
types. Merge every plan only after confirming `validateGraph` passes with 0 failures. No root
node or `contains` needed (removed in v3.3; scope is carried by the vault boundary, membership
by the id convention `<typeSlug>:<system>:<slug>`).

**This file is the "procedure."** The **carving / granularity / naming / coverage / incremental
follow-up quality rules** for Component / Concern / Layer (alias: Pocket / Vein / Stratum) are
split out into `carving-rules.md`. Each step here must satisfy the corresponding section of
carving-rules.md. A mutation that follows only the procedure but fails to satisfy carving-rules
is defective.

## 0. Prime rule — write "meaning" (a "constituent summary" is not meaning)

The single rule that runs through all distilled text (File / node summary and description, and
the naming of Component / Layer / Concern). Every step satisfies it.

- **Constituent summary** = a mechanical restatement of the internal parts. For a File, its
  symbols / imports; for a Component / Layer / Concern, an enumeration of the File set it bundles.
  "What is inside."
- **Meaning** = why it exists / what it is for / which concern or responsibility it carries.
  "What it is for."
- **Always write meaning.** Do not pad with an enumeration or restatement of constituents
  (= shirking). Even for a thin junction, write its own meaning (why it was bundled).
- **Write a description in principle** (same standard as SKILL.md §Mutation Plan / carving-check
  #14). What you write is meaning (what the collection or crosscut means). **Omit only when it
  would be nothing more than a copy of the summary** (better to omit than to pad with a list of
  constituents). Even if the description is close to the summary, there is no problem as long as
  it states meaning — **no equivalence check is performed**.
- **Machine-produced constituent summaries** (File summary / Component・Layer candidate summary)
  carry `summary_provisional: true`. Rewrite to meaning and remove `summary_provisional`. Leaving
  it in makes carving-check stop with a `summary-provisional` ERROR.
- Deciding whether what you wrote is meaning or a constituent summary is the **responsibility of
  the same LLM that writes it** (no separate machine check is placed — an after-the-fact judgment
  by the same LLM is circular and meaningless). So obey this rule **at the time of writing**.

## Inputs (provided by indexer / environment)

- Dependency-community Component candidates and topology Layer candidates
  (`judgment_input.member_files`).
- `{path, role, summary}` for all Files (summary already interpreted per
  `interpretation-guidance.md`).
- The list of `role=documentation` doc Files (+ read the body if needed).
- `git log` (hash, date, subject; chronological).

## 1. Component / Layer naming (graph distance is the unit, the LLM names)

- Update existing candidate nodes' `title`/`summary` to **meaning** (what that functional boundary
  / architecture layer carries; §0), remove `summary_provisional`, set `candidate:false`, delete
  `judgment_input`. The candidate summary is a constituent summary (a machine template of the
  bundled File set), so do not refill it with a restatement of the enumeration.
- **Do not carry over machine placeholder names (titles containing `band0` / `c1` / `(N files)`)** —
  always replace with a meaning title of "what that layer/cluster carries" + a meaning kebab slug
  (canonical: carving-rules.md "Meaningful naming required").
- Reject meaningless clusters with accept=false (remove the node and its incident edges).
- Do not change the structure (membership is decided by the dependency graph).
- Strictly follow carving-rules.md "Meaningful naming required", "Component carving", "Layer
  carving" for naming / granularity / foreign-body inspection / meaning slug / Layer exclusion
  rules (items: meaning title/slug, placeholder prohibition / same-directory principle / granularity
  guard / Layer covers only runtime-dependency targets / tests in the same Layer as the
  implementation). carving-rules.md is canonical for criteria and thresholds; this file does not
  restate them.
- Carve completion is enforced by a machine gate: carve is complete only once `carving-check`'s
  `candidate-uncarved` / `placeholder-title` / `summary-provisional` reach **0 ERROR** (finalizing
  with placeholders still in place stops it).

## 2. Concern (modeling crosscutting concerns)

**The fundamental difference from Component / Layer.** Component is a dependency community, Layer
is a topology depth band — for both the indexer emits candidates deterministically, and the LLM
carries the naming and meaning-assignment. **Concern has no such scaffold.** Crosscutting concerns
do not appear in structural distance. It is the act of the LLM itself conceptually modeling "what
crosscutting concerns run through this system," and it is the step in all of carving that most tests
the LLM's emergent understanding.

### Procedure

1. **Crosscutting-concern modeling from the whole picture (primary).** Once the structure is
   visible via Component / Layer, survey the whole codebase and ask "what crosscutting concerns run
   through this system." Mobilize domain knowledge, general software-architecture patterns
   (authentication/authorization, observability, error handling, encryption, i18n, configuration
   management, auto-update, etc.), and this system's specific characteristics to discover
   crosscutting concerns regardless of whether machine candidates exist.
2. **Blind-spot check via machine hints (auxiliary).** Cross-check the output of `concern-hint`
   (embedding-proximity clustering, for Concern discovery) and the `cross_component_in_degree ≥ 2`
   structural signal against your own modeling as a blind-spot check. If the machine picked up a
   crosscut you had missed, add it. Conversely, that the machine emitted nothing does not mean no
   crosscutting concern exists.
3. Verify for each Concern the **crosscut condition (≥2 Components), single-motive principle, and
   prohibition of double representation with Component**. carving-rules.md "Concern carving" is
   canonical for the quality rules; this file does not restate them.
4. New `Concern` node `concern:<sys>:<slug>` + `Concern -evidenced_by-> File`.

## 3. Document distillation

- Allowed nodes: `Decision` / `Risk` / `OperationalKnowledge` / `Concern`.
- Provenance links (these only are legal):
  - `Decision|Risk|OperationalKnowledge -documented_by-> File(source doc)`.
  - `Concern -evidenced_by-> File(source doc)`.
- `Constraint` cannot use `documented_by`. If used, `Constraint -constrains->
  File|Decision|OperationalKnowledge`. Prefer Decision/OK by default.
- `Decision -derived_from-> ConversationChunk|Investigation` is also allowed (when connecting to
  history).

## 4. git history → knowledge

- Nodes: `ConversationChunk` (development episode) / `Investigation` / `Decision`.
- Legal edges only:
  - `ConversationChunk -discussed_in-> Investigation`
  - `Investigation -led_to-> Decision`
  - `Decision -derived_from-> ConversationChunk|Investigation`
- Bundle into ~12–25 nodes (do not turn all 132 commits into nodes). Keep retreats/migrations/
  long struggles too.

## 5. Knowledge-axis seeding (always on first index, after carve completes)

Even once carve (axis 2: Component / Concern / Layer) completes, if the knowledge axis (Goal /
Constraint / Decision / RejectedOption / Risk / OperationalKnowledge) stays empty, **design-review's
scope-creep / roadmap lens is invalid** (with no Goal to check against, you cannot ask "does this
stray from the purpose"). This state is made visible by `carving-check`'s `knowledge-floor` rule as a
WARN `knowledge-floor-goal-missing` (0 Constraints is the same-shape WARN). After carve completes,
raise the knowledge-axis floor via 5a / 5b below.

### 5a. User interview → Goal tree + key Constraints

Raise it via a short interview with the user. **Goal / Constraint / RejectedOption are all
sufficiently handled by typed-add (`add-goal` / `add-constraint` / `add-rejected-option`)** (the
commit-mutation template is for complex cases). Three questions suffice:

1. **What is this system's end state** → `Goal` tree. Hang lower Goals off a single top-level Goal
   via `refines` (Goal → Goal), **3–7 total**. Granularity at the unit you can speak of on a roadmap
   (not an enumeration of feature names; §0 prime rule — meaning, not constituents). State
   vocabulary is `"planned" | "active" | "achieved" | "abandoned"` (no state is also legal).
   - `node graphrag/cli.ts add-goal --system <s> --slug <slug> --title "..." --summary "..."`
     `[--refines <goal-id>]` (hang off an upper Goal) `[--state planned|active|achieved|abandoned]`
     `[--derived-from <conversation/investigation-id>]` (when grounding in a source
     conversation/investigation). Create the top-level Goal without `--refines`, and hang lower Goals
     off it with `--refines <top-level id>`.
2. **What are the constraints you must absolutely uphold** → key `Constraint`s. Attach them to
   targets (Decision|File|OperationalKnowledge) via `constrains`. A crosscut-altitude `constrains` is
   not in the grammar, so when there is no altitude, enumerate the Files + state the scope explicitly
   in the summary (carving-rules.md "No laundering a Constraint as a Decision").
   - `node graphrag/cli.ts add-constraint --system <s> --slug <slug> --title "..." --summary "..."`
     `--constrains <id,...>` (**required ≥1**, target Decision|File|OK). Constraint cannot use
     documented_by and needs no evidence, so it does not take `--evidence`.
3. **What options did you try in the past and discard** → `RejectedOption` (rejected options are
   first-class). Prioritize those that could tempt you again. `add-rejected-option` (source required).

For all of them, stacking aliases via `--aliases "<natural-language term (Japanese)>,<code-language
term (English)>"` makes them easier to retrieve later from loose questions (aliasExact is the
strongest lexical match; SKILL.md §Stacking aliases).

### 5b. Seed from harvest-history candidates (knowledge harvest at first index)

`harvest-history --root <repo> [--system <name>] [--out <path>]` emits candidate JSON from git
history via **deterministic extraction only, no writes** (same philosophy as concern-hint; adoption
is judged by the LLM which then typed-adds):

- **Revert commits** → `RejectedOption` candidate (`suggested_slug` / `title` / `commits` / `note`).
  "Put in once and reverted" is the top thing to be tempted by again. Look at the content and make an
  **individual judgment** on whether it is worth keeping as a rejected option (do not mechanically
  turn every one into a node).
- **Comment markers** HACK / FIXME / WORKAROUND / XXX → `OperationalKnowledge` / `Risk` candidate
  (`path` / `line` / `marker` / `text`). Pick up only those worth promoting to standing operational
  knowledge / risk (do not transcribe temporary TODOs).

Write adopted candidates with typed-add (`add-*`). Source is required (`documented_by` /
`derived_from`) and the write-time duplicate_check works as usual — if a suspect duplicate is
flagged, first consider appending to / merging into the existing node.

## Merge and verify

1. Apply each plan JSON to the base graph (duplicate ids skip, edge ids are generated
   deterministically).
2. Run `validateGraph`. Drop failing edges (invalid type pair / missing endpoint), re-verify to 0.
3. Pass the **carving quality gate** (carving-rules.md "Pre-submission carving checklist"). In
   particular the coverage gate: every File under `src/` except allowed-orphans belongs to a
   Component, and every File under `src/` + `packaging/` except those hit by exclusion rules belongs
   to a Layer. If unassigned Files remain, state them explicitly as allowed-orphans in the mutation
   plan's `reason`.
4. Apply to the vault via `commit-mutation <plan.json>` (the vault writer bundles validate → atomic
   write → vector-index update → git commit).
5. Regression: top-1 on known-answer queries, and impact propagation traceable by a no-context agent.

## Incremental conceptual-pass (handling changed / new Files)

Follow `change_status: new|changed|unchanged` from `node graphrag/cli.ts index`. Details in
carving-rules.md "Incremental follow-up". Key points:

- `unchanged`: no conceptual-pass needed.
- `changed`: regenerate the File summary per `interpretation-guidance.md`. Keep membership.
- `new`: **always re-evaluate carving**. Check whether it can be absorbed into an existing Component
  by the same-directory principle; if not, carve a new Component. If a new directory appears, a new
  Component is required.

## Edge type-pair quick-ref (`graphrag/schema.ts` is authoritative)

- `evidenced_by`: Layer|Concern|Component → File
- `documented_by`: Decision|RejectedOption|Risk|OperationalKnowledge|Investigation → File
- `derived_from`: Decision|RejectedOption|Risk|OperationalKnowledge|Goal → ConversationChunk|Investigation
- `discussed_in`: ConversationChunk → Investigation
- `led_to`: Investigation → Decision
- `constrains`: Constraint → Decision|File|OperationalKnowledge
- `has_premise`: Decision|OperationalKnowledge|Investigation → Decision|OperationalKnowledge|Constraint|Risk|Goal
- `refines`: Decision|OperationalKnowledge → Decision|OperationalKnowledge / Goal → Goal
