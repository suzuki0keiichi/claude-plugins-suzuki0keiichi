# Indexing and Carving

**The procedure for first indexing and the conceptual pass.** It does not appear in typical operation
(read / typed-add / commit-mutation). **Read it whenever you index an unknown repository for the first
time.**

Everyday use is a single `node graphrag/cli.ts carve --root <repo> --system <name>`. This reference is
for what happens inside that, and for when you want to customize.

## First import / re-index

```sh
node graphrag/cli.ts carve --root <repo> --system <name> [--vault <dir>] [--previous <path>]
```

`--system <name>` is the **namespace label** of the id convention `<typeSlug>:<system>:<slug>` (no System
node is created). What the indexer generates is File / Component / Layer nodes and `evidenced_by` only.

Inside:
1. `index` (= `indexCodebase`) — git ls-files + content_hash + role classification + symbol/import
   extraction. **Both the File summary and the Component/Layer candidate summary are machine templates of a
   "constituent summary" (symbols/imports or the bundled File set), and `summary_provisional: true` is
   set** (a self-declaration of incompleteness). Until you rewrite to "meaning" (what it does / what for /
   which concern) in the conceptual pass and remove this flag, it is "incomplete."
   **Carrying over the previous real File summaries on re-index comes only from the canonical vault**
   (`<root>/.graphrag/vault` is auto-resolved; also settable via `GRAPHRAG_VAULT_DIR` / `--vault`). The
   `--previous` graph.json / indexed-graph.json scaffold is for change_status only, and its summaries are
   machine templates so they are not carried over (details in the index section of `cli-primitives.md`).
   **Therefore "re-index → rebuild the vault from the scaffold" must not be done** (it would crush the
   re-authored summaries). What a re-index updates is the scaffold (indexed-graph.json); the vault is
   written only by the conceptual pass's mutations.
2. `concern-hint` — Union-Find clustering of File groups that span different Components via the vector
   index (machine hints for Concern). It is for blind-spot checking the Concerns the LLM modeled in the
   conceptual pass, not the lead in Concern discovery (the lead is the LLM's conceptual modeling; see
   `conceptual-pass.md` §2). **By default it rejects when any File still carries `summary_provisional`**
   (template summaries are dominated by natural-language words in the embedding, so clusters degenerate into
   typescript/components etc. and the vertical thread becomes meaningless; `--allow-provisional` if you
   accept this knowingly).
3. `edge-suggest-policy` — extracts sets_policy_for candidates by embedding proximity for each
   Decision/OK/Risk.
4. `carving-check` — quality gate (sequential slug / Layer contamination / coverage / exemption accounting
   / duplicate / missing linkage / knowledge-floor / superseded-premise / superseded-no-successor).

**Even at the stage with no vector index (first time) it passes in one command**: when carve detects the
vector index is absent, it auto-builds after index and runs straight through the suggest stages (2·3) (the
former 3-step manual round-trip of "carve → `vector-index` → carve again" is unnecessary). When the
embedding endpoint is unreachable it skips the suggest stages as before, with an explicit note in the output
(non-fatal). Note that `GRAPHRAG_VECTOR_INDEX_PATH` is an **env for vault indexing only**, and carve does
not read it (carve's working index is at the conventional path under `.graphrag/cache/`).

**summary_provisional ERROR exemption**: packaging / generated / lockfile Files are not subject to the
meaning-summary requirement (already excluded from embedding) — they are reported as an INFO count rather
than ERROR. If `summary_provisional` remains on an implementation File other than the exempted ones, it is an
ERROR as before.

## Division of scaffold and interpretation (invariant)

- **The indexer is the deterministic scaffold only**: git ls-files, freshness via content_hash / git_head,
  change_status, role classification (source/test/doc/config/...), symbol/import extraction, dependency graph.
  **It does not interpret meaning.** It emits File summaries as machine templates (`summary_provisional:
  true`), and leaves meaning to the conceptual pass. The output self-verifies `validateGraph` passage and can
  flow straight into the conceptual pass and `vector-index`-ing (the result is applied to the vault via
  `commit-mutation`).
- **Component / Layer are emitted by graph distance**: dependency-community detection + hub decay = Component
  candidates, dependency-topology depth band = Layer candidates. No heuristics. **The indexer emits with the
  canonical names (`Component` / `Layer`, ids also `component:` / `layer:`)** (it does not emit the old
  aliases `Pocket` / `Stratum`).
- **Concern is not emitted by distance**: crosscut = concept. **The LLM surveying the whole codebase and
  modeling it conceptually** is the lead. `concern-hint` (embedding-proximity clustering) is for blind-spot
  checking after the LLM's modeling.
- Role-aware retrieval (`DEFAULT_ROLE_WEIGHTS`) is ON by default: implementation ranks above
  doc/test/config/thin entry points. Overridable via `options.roleWeights`.

The LLM layers concepts on top of the scaffold. Each result is a mutation plan → `validateGraph` 0 failures →
merge. **Do not add new schema types; increments only**:

## Conceptual pass (graph-distance + meaning interpretation)

1. **Interpretive generation of File-responsibility summaries** — the primary lever for retrieval quality and
   the main embedding carrier. **Strictly follow** `references/interpretation-guidance.md`. Update only changed
   Files. **Rewrite the machine template (`summary_provisional`) to a real summary, and remove
   `summary_provisional` from the rewritten Files** (forgetting to clear it is machine-detected as a
   concern-hint rejection / carving-check ERROR). Leaving the template (a mechanical restatement of path,
   role, dependencies) = shirking.
2. **Component/Layer naming, Concern conceptual grouping (crosscut), concept-doc distillation, git history →
   knowledge** — **follow** the schema-legal mapping in `references/conceptual-pass.md`. Strictly follow
   `references/carving-rules.md` for the carving / granularity / naming / coverage / incremental-follow-up
   quality rules (conceptual-pass.md is the "procedure," carving-rules.md is the "quality guard" — a division
   of roles). **The Component/Layer candidate summaries the indexer emits are "constituent summaries" (machine
   templates of the bundled File set) and carry `summary_provisional: true`. At naming time, rewrite to a
   "meaning" summary (what that functional boundary / architecture layer carries) and remove provisional**
   (symmetric with the File summary; leaving it is a carving-check ERROR).
3. **Carving quality gate** — before applying the mutation, pass carving-rules.md's "Pre-submission carving
   checklist." In particular, the **prohibition of remaining provisional summaries (`summary-provisional`
   ERROR; common to File / Component / Layer candidates)**, the coverage gate (Files under `src/` belong to a
   Component / Layer), the prohibition of sequential slugs, and the prohibition of double representation
   between Component and Concern are enforced. `carving-check` detects both canonical and old-alias type names
   (`canonicalType` normalization).
4. **Knowledge-axis seeding (knowledge harvest at first index)** — after carve completes, use `harvest-history
   --root <repo> [--system <name>] [--out <path>]` to **deterministically extract** revert commits (=
   `RejectedOption` candidate) and comment markers HACK / FIXME / WORKAROUND / XXX (= `OperationalKnowledge` /
   `Risk` candidate) from git history (no writes; candidate JSON. Same philosophy as concern-hint — the LLM
   judges adoption individually and typed-adds). Alongside, raise a Goal tree (3–7 via refines) and key
   Constraints through a short interview with the user. The procedure is in `references/conceptual-pass.md`
   "Knowledge-axis seeding." Leaving 0 Goals makes `carving-check` emit a `knowledge-floor` WARN
   (`knowledge-floor-goal-missing`), and design-review's scope-creep / roadmap lens stays invalid.

Design rationale and intentional non-support are in `references/carving-rationale.md`. The empirical history
(5/5 convergence, impact-propagation tracing with no context, quality regression gate) is in
`docs/history/indexer-redesign-notes.md` (historical).

## Bundled references (carving-related)

- `references/carving-rationale.md`: why these 12 node types / this edge grammar / RejectedOption first-class /
  Layer≠Concern≠Component / Symbol not a node. The core value of the schema definition.
- `references/interpretation-guidance.md`: **general guidance for File interpretation summaries** (the LLM
  follows; repo/query independent). The primary lever for retrieval quality.
- `references/conceptual-pass.md`: the schema-legal mapping of the conceptual pass (Component/Layer naming,
  Concern conceptual grouping, doc distillation, git history → knowledge, knowledge-axis seeding). Specifies the
  **procedure**.
- `references/carving-rules.md`: the **quality guard** for Component / Concern / Layer carving / granularity /
  naming / foreign-matter inspection / coverage gate / incremental follow-up. Each step of conceptual-pass.md
  must satisfy these rules. Always pass the pre-submission carving checklist.
- `docs/history/indexer-redesign-notes.md` (historical): indexer essence, redesign guidelines, measured
  capability eval and the 5/5 convergence log.
