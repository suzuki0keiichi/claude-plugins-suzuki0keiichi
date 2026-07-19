# CLI Primitives Reference

Flag details for the primitive verbs invoked via `node graphrag/cli.ts <primitive> [flags]`.
Typical operations are fully covered by the **headline** verbs (ask / carve / commit-mutation / add-* / inspect).
Consult this reference only when you need **per-stage fine-grained control** — e.g. "change the neighbors", "get just the evidence packet on its own", "regenerate only the index".

> FalkorDB integration was removed in v3 (task C). The `mutate` / `falkor-sync` / `falkor-export` / `list` / `drop` / `branch` verbs no longer exist. Writes go through `commit-mutation` / `add-*` (vault writer).

Every verb reads `.env` once at cli.ts launcher startup, so `GRAPHRAG_*` env is seen identically from any primitive.

---

## brief — summary response (resume / query)

```sh
node graphrag/cli.ts brief --mode <resume|query> [--query "<text>"] [--limit N] [--neighbors N] [--call-number N]
```

- `--mode resume`: returns the active Investigation (for focus continuity, read-only). When the vault holds open Goals (`state: planned|active`), also returns `open_goals` (count + oldest-first headlines, cap 5) — deferred work resurfaces at the moment you are deciding what to continue; absent when there are none ("emit only when there is something" convention)
- `--mode query`: returns the top-N of ranked search as 280-char summaries
- `--query`: required in query mode
- `--limit`: matches cap (default 5)
- `--call-number`: for repeat-suppression detection (usually auto via `ask`)

Query expansion is handled by `brief` (and thus by `ask`'s escalation):

- `--graph-rerank on|off` (**default off**): boosts the score of top candidates by their graph adjacency count (reason gets `graph:+N`). Default off because votes scale with hub-ness and push down the correct leaf — consider on only for graphs with balanced island structure.
- `--gist "<expected one-liner>"` (optional): embeds the question and the gist separately and passes them as multiple query vectors (semantic = max cosine against each vector). Catches paraphrases that are hard to hit with the question alone.
- These are normally used via `ask "<question>" [--graph-rerank on|off] [--gist "<one-liner>"]` (`ask` wires them into `brief`).

Output: `{ generated_by, mode, graph: {...}, active|query: {...}, usage: [...] }`

## search — ranked neighbor expansion

```sh
node graphrag/cli.ts search --query "<text>" [--limit N] [--neighbors N] [--types T1,T2]
```

Ranked match list + neighbor (N-hop expansion) edges. `ask` usually substitutes evidence for this, but call it directly when you want neighbors at 2-3 / to narrow with `--types`. The neighbor-expansion graph_context is truncated at ~10 edges per node (in edge-type priority order) / ~40 overall (same cap as `evidence`).

## evidence — provenance-attached answer packet

```sh
node graphrag/cli.ts evidence --request "<text>" [--limit N] [--neighbors N] [--types T1,T2]
```

direct_evidence (ranked) + graph_context (neighbors) + retrieval_policy + answer_instructions. Called internally as the final escalation stage of `ask`.

Plan templates for Goal / Constraint / Concern / Layer / Component / Update / Delete are in `references/mutation-templates.md` (application is via `commit-mutation`).

## index — deterministic indexing (git ls-files + role classification + deps)

```sh
node graphrag/cli.ts index --root <repo> --system <name> [--vault <dir>] [--previous <path>]
```

- Generates File nodes + import/dep edges with **no semantic interpretation**. `--system <name>` is the **namespace label** of the id convention `<typeSlug>:<system>:<slug>` (no System node is created; the root node type and contains were removed in v3.3).
- **A prior real File summary is inherited only from the canonical vault.** On re-indexing, index resolves the vault in the order
  `--vault` → `GRAPHRAG_VAULT_DIR` → `<root>/.graphrag/vault`, and
  unchanged Files inherit the vault's authored summary (= one that is not `summary_provisional`).
  The vault's machine templates (`summary_provisional: true`) are not inherited and are rebuilt.
- `--previous` (graph.json / indexed-graph.json scaffold) is **only for change_status / deletion detection**.
  A scaffold's summary is always a machine template, so **do not use it for summary content**
  (an old-version graph carries no flag either and becomes a hole that mistakes "template = real", so it is structurally distrusted).
  On a first run with no vault etc., every File is rebuilt with `summary_provisional: true` (= the safe side).
- Called internally by the `carve` headline. Call it standalone only when you want to re-index alone.

## vector-index — build vector index

```sh
node graphrag/cli.ts vector-index [--graph <path>] [--out <path>] [--prefix-policy auto|off]
```

Embeds the text of File / Decision etc. via the embedding endpoint (`GRAPHRAG_EMBEDDING_ENDPOINT` auto-detected or explicit) and outputs JSON. `commit-mutation` performs the index update (non-fatal) internally after writing to the vault, so you need not run it by hand after a mutation. Call it directly when you want to index the whole vault for the first time.

- `--prefix-policy auto|off` (default auto): when the model has a prefix policy (e.g. `nomic-embed-text`'s document/query prefixes), it embeds with the document prefix and records `prefix_policy` in the index meta. The query side **reads the index meta** and adds the query prefix only to indexes that have `prefix_policy` (not to old indexes without the meta = prevents mixing). `off` disables it. `ask` / the duplicate gate / the suggesters all follow the same policy.

## vault-build — graph.json → Obsidian vault

```sh
node graphrag/cli.ts vault-build <graph.json> <vault-dir> [--force]
```

Generates a vault from graph.json (indexer output etc.). Not needed for normal knowledge writes, since `commit-mutation` atomically writes directly to the vault without going through graph.json. Use it e.g. when turning indexer output into a vault. Arguments may be omitted if `GRAPHRAG_GRAPH_JSON_PATH` / `GRAPHRAG_VAULT_DIR` are already set.

**Since it wipes and rebuilds, this is only for the initial build of an empty vault.** It deletes `<vault-dir>` and recreates it from graph.json. The index (graph.json) only holds File / Pocket / Stratum, so running it against a vault that already has hand-written-back knowledge nodes (Decision / OK / Risk / Constraint / Vein …) will delete them, since they are outside the index. **Overwrite guard**: it aborts (exit 1) if the existing vault has "nodes absent from the source graph". Initial build of an empty vault / re-indexing where the graph is a superset pass through as-is. If you want to re-index a vault where knowledge has accumulated, use the commit-mutation / merge flow, not build-vault. If you absolutely must wipe everything, use `--force` (or `GRAPHRAG_VAULT_BUILD_FORCE=1`).

## vault-import — vault → graph.json (round-trip)

```sh
node graphrag/cli.ts vault-import <vault-dir> [<out.json>]
```

Rebuilds graph.json from the vault. **For round-trip equivalence verification** (edit vault → import → diff against the original graph). Not used in day-to-day operation.

## concern-hint — machine hints for Concerns (embedding proximity clustering)

```sh
node graphrag/cli.ts concern-hint --graph <path> --vector-index <path> [--threshold 0.92] [--knn 1] [--min-cluster 3] [--min-span 2]
```

Union-Find-clusters groups of Files that span different Components by embedding distance, and outputs candidate JSON. **Concern discovery is driven primarily by the LLM's conceptual modeling** (`conceptual-pass.md` §2); this command is for blind-spot checking after that modeling. Called inside `carve`. Call it directly only when you want to tune the threshold.

## edge-suggest-policy — batch extraction of binding / relations candidates

```sh
node graphrag/cli.ts edge-suggest-policy --graph <path> --vector-index <path> [--missing-only] [--changed-files <list>]
node graphrag/cli.ts edge-suggest-policy --relations --graph <path> --vector-index <path> [--top-n 50]
```

The entry point for re-growing suggestions in batch on stock nodes that were created before 3.8 and never received a write-time suggestion.

Binding mode (default): for each Decision/OK/Risk/Constraint, extracts by embedding proximity the top N Files it "should be touching" and returns them with a per-type fixed suggestion edge type (`edge_type`; Decision→sets_policy_for / Risk→risks_in / OK→documented_by / Constraint→constrains) (same shape as write-time suggestions). `--missing-only` narrows to unlinked nodes (D/OK/R skip if sets_policy_for or documented_by points at an implementation File, Constraint skips if it has even one constrains = same definition as carving-check's constraint-binding-missing). Narrow via `--changed-files` in a post-merge hook etc.

`--relations` mode: batch-lists same-type knowledge-node pairs (Decision×Decision / OK×OK / Risk×Risk / Constraint×Constraint / Goal×Goal / RejectedOption×RejectedOption) whose cosine is in [0.80, 0.92), in descending similarity order (`{ mode, pairs:[{a_id,b_id,similarity,note}], pair_count }`). The band is the same as the write-time relations byproduct (shares duplicate-check's RELATION_BAND_LOW/HIGH); which of refines / has_premise / supersede to use is judged by the LLM reading the content. 0.92 and above is a duplicate suspect, which is carving-check #10's territory (node-duplicate-suspect) and is not surfaced here. It does no extra embedding computation and uses only the existing vectors in the vector index.

## carving-check — automated quality-gate verification

```sh
node graphrag/cli.ts carving-check --graph <path> [--vector-index <path>] [--config <path>] [--json]
```

Machine-judges: sequential slugs / Layer contamination / Component completeness / duplicate detection / missing bindings / notation-variant duplicates by embedding distance / knowledge-floor (0 Goals · 0 Constraints) / superseded-premise (a live node has_premise onto a terminal-state node). Exits 1 if there is an ERROR. Automatic as the final stage of `carve`. `commit-mutation` (vault writer) does not embed carving-check, so run it by hand as needed after a mutation involving carving.

`--config <path>` specifies the project-specific allowed-orphan exemption config (`.graphrag/carving.json`) (when omitted, resolved by convention from the graph path). Exemption accounting (each exemption's basis kind `builtin:<name>` / `role:<role>` / `config:<path>`, the count from config, and the exempted proportion of implementation Files) is always printed in text / JSON output, with WARN when the proportion > 15%. Config invalidity (glob characters / missing reason·added) and stale-exemption (a path absent from the graph) are ERROR. Threshold tuning: `--jaccard-threshold` (0.4) / `--dominance-threshold` (0.7) / `--duplicate-threshold` (0.92).

## carving-allow — manage the orphan-exemption config (.graphrag/carving.json)

```sh
node graphrag/cli.ts carving-allow add --path <p> --reason <r> [--config <path>]
node graphrag/cli.ts carving-allow remove --path <p> [--config <path>]
node graphrag/cli.ts carving-allow list [--config <path>]
node graphrag/cli.ts carving-allow migrate --graph <path>   # outputs old builtin-matching Files as proposed config entries (no writes)
```

Literal paths only (glob/regex characters are an error). `add` / `remove` are atomic writes (tmp+rename) sharing the vault-lock. Inside a git repo they attempt git add+commit; failure is non-fatal and noted in the output. carving.json is a human-owned conceptual layer on par with Layer/Concern/Component — the LLM may only propose; appends require user approval.

## harvest-history — deterministic extraction of knowledge candidates from git history

```sh
node graphrag/cli.ts harvest-history --root <repo> [--system <name>] [--out <path>]
```

No writes, deterministic extraction only: (1) revert commits → `RejectedOption` candidates (`suggested_slug` / `title` / `commits: [hash, subject, date]` / `note`), (2) comment markers HACK / FIXME / WORKAROUND / XXX → `OperationalKnowledge` / `Risk` candidates (`path` / `line` / `marker` / `text`). Candidate JSON in the same spirit as concern-hint — adoption is judged case by case by the LLM and typed-add'd. Procedure in `references/conceptual-pass.md` under "knowledge-axis seeding".

## staleness-check — machine extraction of stale-knowledge candidates

```sh
node graphrag/cli.ts staleness-check [--root <repo>] [--vault <dir>] [--threshold-commits N]   # defaults: root=cwd, threshold=5
```

For the Files pointed at by a knowledge node's (Decision/Constraint/Risk/OperationalKnowledge) `documented_by` / `sets_policy_for` / `constrains` / `enforced_by`, counts via git log the commits that touched that path since the node's `generated_at`, and lists those at or above the threshold as candidates (`node_id` / `node_title` / `file_path` / `commits_since` / `last_commit_subject`). Read-only, no semantic judgment — the judgment of whether it is truly stale is left to a human-initiated audit. Vault via `--vault` or `GRAPHRAG_VAULT_DIR`.

## constraint-check — Constraint enforcement-wiring check (read-only)

```sh
node graphrag/cli.ts constraint-check [--vault <dir>] [--root <repo>] [--strict]   # defaults: root=cwd; exit 0 = ok/warn, 1 = error (--strict: warn also 1)
```

Walks every Constraint and cross-verifies its `enforced_by` wiring in **both directions** (registry layer walker — running the enforcers themselves stays CI / pre-commit / pr-review's job):

- graph → code: `enforcer-missing` (target check file gone from disk — **error**: the graph promises enforcement that can no longer run) / `enforcer-skipped` (skip markers, best-effort per language) / `marker-missing` (check file lacks the `graphrag:enforces constraint:<system>:<slug>` comment — the `graphrag:` namespace lets readers who don't know the convention trace it: grep → `.graphrag/` → vault; `git grep graphrag:enforces` lists every registered enforcer).
- code → graph: `orphan-marker` (marker points at a nonexistent Constraint; tombstone ledger traced for a 301 successor) / `unregistered-enforcer` (marker present but no `enforced_by` edge — returns a **ready-made `plan_fragment`** including the File node when absent, paste into commit-mutation).
- registry hygiene: `unguarded` (no `enforced_by`, no `enforcement:"none"` declaration) / `unenforceable-no-reason` / `contradictory-enforcement`.

Every finding carries `next_step` (what is wrong + concretely how to fix). Summary: `constraints: {total, enforced, unenforceable, unguarded}`. Marker scan uses `git grep` over tracked files, ignoring `*.md` and `.graphrag/`. Project vaults return ok with an explanatory note (enforcement is a system-vault concept). Recommended wiring flow: write the marker into the check file first, re-run — `unregistered-enforcer` hands you the exact fragment.

## frame-check — placement map for new/changed files (read-only)

```sh
node graphrag/cli.ts frame-check [--files <p,...>] [--diff <base...head>] [--root <repo>] [--vault <dir>] [--threshold-files N] [--strict]
# input default: worktree changes (git diff --name-only HEAD + untracked). exit 0 (--strict: warn → 1)
```

Matches each input path against Component **footprints** (the directory territory derived from member Files' `evidenced_by` paths) and returns a per-file map: `entries[] = {path, status, claimants}` with `status` ∈ `registered` / `known-unframed` / `exempt` (BUILTIN_ORPHAN_PATTERNS + `.graphrag/carving.json`, same vocabulary as carving-check) / `non-impl` / `unwired` / `unclaimed`. **`unclaimed` is not a verdict** — small clusters legitimately have no Component (carving philosophy); the map shows candidates without accusing.

Findings are limited to two high-precision cases, each with `next_step`:

- `in-footprint-unwired` — the file sits inside exactly **one** component's home directory but has no `evidenced_by`. Either it belongs there (paste the included `plan_fragment` — File node included when absent), it belongs elsewhere (move it while it is cheap), or exempt with a reason. Flat layouts (overlapping footprints) never fire this — silence over friendly fire.
- `component-candidate` — a touched directory now holds ≥ threshold unregistered implementation files (counted via `git ls-files`, exemptions excluded). Not a violation: the signal that **a Component wants to be born** — register it (+ `evidenced_by` members) or exempt the pile with reasons.

This is carving-check #3/#4's norm applied instantly to arbitrary paths without waiting for a re-carve. Wired consumers: the `graphrag-pr-review` mechanical pass (diff files) and the PostToolUse Write hook (`hooks/frame-map.mjs` — injects the local map right when a new impl file is created; silent when there is nothing to show).

## delta-check — the read-side of the commit boundary (read-only)

```sh
node graphrag/cli.ts delta-check [--files <p,...>] [--diff <base...head>] [--root <repo>] [--vault <dir>] [--strict]
# input default: worktree changes (same contract as frame-check). exit 0 (--strict: warn → 1)
```

Deterministic reverse lookup from the diff to the registered knowledge wired to it — no embedding, no similarity, only edges and grep. Motivation (VDU/MOT field reports): every case where knowledge "existed but did not help" had the same shape — the knowledge lived on the canonical side (an OK, a Constraint, an authority declaration) while the session that broke it never walked past it. The one moment every session reliably passes is the commit boundary; this verb makes that moment read.

Four sections:

- `connected_knowledge` — headlines (id / type / title / state / summary-line / via edges) of every Decision / Constraint / OK / Risk / Goal / Investigation reaching the changed files via `constrains` / `documented_by` / `sets_policy_for` / `enforced_by` / `risks_in`. Sorted Constraint-first, capped at 20. **A reading list, not a diagnosis** — superseded nodes appear with their state (the successor hint is your cue to check). Goals with `state: planned` wired to a file resurface deferred work the moment a commit touches that place.
- `authority_echoes` — identifier-shaped aliases (`ERROR_STATUSES` / `zero_bytes` style; plain lowercase words are skipped) of File-wired knowledge nodes, found in the diff's **added lines** outside the node's home files. This catches the second implementation in the act of being written. A legitimate import triggers it too — the added line is attached so the writer can tell in one glance; nothing is judged.
- `marker_findings` — `graphrag:see` / `graphrag:enforces` markers inside changed files whose target is missing (`marker-broken-ref`), deleted with ledger trace (`marker-tombstoned-ref`, 301 successor named), or superseded (`marker-superseded-ref`, refines-successors named). String-literal occurrences are ignored (test fixtures don't false-positive). Marker grammar: `graphrag:see <type>:<system>:<slug>` — slug charset only, no file ids.
- `placement_findings` — frame-check's two high-precision findings for the same paths (entries map is NOT included; call frame-check directly when you want the per-file map).

**Output contract: clean = a one-line summary and nothing else.** This is what makes it safe to wire into the commit-boundary hook (`hooks/proactive-persistence-reminder.mjs` runs it on every `git commit` and injects headlines only when there is something to read). `status`: `clean` / `info` (connected knowledge or echoes — read it) / `warn` (marker/placement findings). Remember what clean does NOT mean: knowledge without edges cannot appear here — the lookup is only as good as the wiring.

## stocktake — Investigation + Goal lifecycle audit (read-only)

```sh
node graphrag/cli.ts stocktake [--vault <dir>] [--days N]   # default threshold 14 days
```

Deterministic suspect extraction, no semantic judgment (adjudication belongs to the `graphrag-stocktake` skill). Investigations: `stateless` (legacy, no state) / `stale-active` (+ `no-generated-at`) / `progress-claim` (title+summary claims WIP). Goals: `stale-planned-goal` / `stale-active-goal` (open Goals past the threshold — deferred work needs a periodic surfacing device or "later" means "never"; fresh open Goals and terminal/stateless Goals stay silent). Each suspect carries `type` (`Investigation` | `Goal`), `state`, `generated_at`, `signals`.

## world-join — join a vault to a world

```sh
node graphrag/cli.ts world-join --world <dir>              # vault via GRAPHRAG_VAULT_DIR / auto-discovery
node graphrag/cli.ts world-join --world <dir> --vault <dir>  # explicit
```

Deterministic two-step: ① add this vault's path and `vault_slug` to world.json (no-op if already present), ② write `GRAPHRAG_WORLD_DIR=<dir>` to `.graphrag/.env` (overwrites existing value). Creates the world directory and world.json if absent. Warns when VAULT.md is missing; warns when `vault_slug` is not set (cross-vault refs will not resolve to this vault).

## xref-check — diagnose cross-vault refs / parent integrity / code markers (read-only)

```sh
node graphrag/cli.ts xref-check [--vault <dir>] [--world <dir>] [--root <repo>]
```

Scans every edge in the vault for a `vault:`-prefixed `to`, tries to resolve it via world.json (slug lookup), and classifies each reference as `resolved` (both vault and node exist) / `broken` (the vault exists but the node is missing) / `orphan` (the slug's vault does not exist) / `unresolvable` (`GRAPHRAG_WORLD_DIR` unset). It also inspects VAULT.md's `parent` (vault containment) and emits `parent_status` (`none` / `resolved` / `orphan` / `self` / `schema-mismatch` / `cycle` / `unresolvable`) in the summary. Read-only — it changes no vault. When `--vault` is omitted, uses the resolved `GRAPHRAG_VAULT_DIR` (including auto-discovery); when `--world` is omitted, uses `GRAPHRAG_WORLD_DIR`.

With `--root <repo>`, additionally sweeps the repo's `graphrag:see` / `graphrag:enforces` comment markers (git grep, `*.md` and `.graphrag/` excluded, string literals stripped) and verifies each target against the vault + tombstone ledger — same three finding kinds as delta-check's `marker_findings` (`marker-broken-ref` / `marker-tombstoned-ref` with 301 successor / `marker-superseded-ref` with refines-successors). Same reference-rot check, opposite direction: vault-side refs above, code-side refs here. delta-check covers the diff-scoped write-moment; this is the periodic full sweep (a natural stocktake companion). Sweep failure (not a git repo) is reported in `code_markers.error`, never fatal.

## fsck — vault integrity check (read-only)

```sh
node graphrag/cli.ts fsck [--vault <dir>]    # exit 0 = ok/warn, 1 = error
```

Fast read-only integrity sweep over the resolved vault (the detection instrument against silent knowledge corruption). Emits a single JSON `{status: ok|warn|error, checks: [...], counts: {files, nodes, edges, errors, warnings}}`. Checks, by stable id:

- `import-parse` — every `.md` parses through the real read path (importVaultFile); failure count + file list.
- `duplicate-node-ids` — no node id is held by more than one file.
- `id-path-consistency` — node id/type ↔ type-dir/filename mapping. Type-dir mismatch = error (folder contradicts frontmatter `type`); basename-only mismatch = warn (drift the next write renames away).
- `edge-endpoints` — every edge endpoint resolves to an existing node; `vault:` cross-vault refs are validated shape-only (`vault:<slug>/<nodeId>` — actual resolution is `xref-check`'s job).
- `schema-validate` — validateGraph (schema-level) passes.
- `round-trip` — import → rebuild in memory → byte-compare against disk (EOL-insensitive, same as the write path). Any differing file = non-canonical serialization, WARN only: drift (hand edits / legacy formatting the next write rewrites), not corruption.
- `git-uncommitted` — uncommitted changes under the vault = ERROR with a recovery hint: this is the signature of a torn write (a mutation wrote its delta but died before its git commit). Non-git vaults get a WARN (torn-write detection unavailable).

Distinguishes corruption (error) from drift (warn): `error` means the vault needs repair before the next mutation can be trusted; `warn` is self-healing on the next write. Vault via `--vault` or `GRAPHRAG_VAULT_DIR`.

## world-refresh — rebuild the cross-vault world-cache

```sh
node graphrag/cli.ts world-refresh [--world <dir>]    # when dir is omitted, GRAPHRAG_WORLD_DIR
```

Rebuilds the copy layer among the three layers of cross-vault retrieval (`canonical: VAULT.md next to the vault` / `address book: world.json` / `copy: world-cache.json`). The output includes each vault's VAULT.md mtime (`profile_mtime`) and node count (`node_count`), and attaches an `intro_hint` to any vault whose mtime is older than 45 days ("VAULT.md unchanged for <N> days; its self-introduction may be stale relative to what has accumulated").

- **world.json** (`<world-dir>/world.json`): pointer list of vault dirs (`{"vaults": ["<path>", {"path": "...", "slug": "..."}]}`). `slug` is the `vault_slug` (cross-vault ref namespace); the xref resolver looks up vaults by slug directly from world.json. Extra keys beyond `path` and `slug` are rejected (anti-rotting-phonebook) — name/description belong in each vault's `VAULT.md`.
- **VAULT.md** (**next to** the vault dir, same placement as `.graphrag`/vector.json): frontmatter `name:` / `schema:` (system/project; system when omitted) / `vault_slug:` / `parent:` + a few lines in the body on "what knowledge is here". Do not place it inside the vault folder (it would be treated as a node and orphan-deleted by a mutation).
- **world-cache.json** (next to world.json): a copy of each vault's self-introduction + embedding + content hash + fetch time. Machine-generated, hand-editing forbidden. Atomic write (tmp+rename).

`ask` attaches `world_hints` ("vault X probably also has knowledge" hints) to its results only when `GRAPHRAG_WORLD_DIR` (or `ask --world <dir>`) is set. A hint's confidence has a relative judgment (`standout`: clear/crowd/single) in addition to the absolute value (confidence), and a top1 that stands out among candidates is promoted to high. The primary source of hits is lexical match in the VAULT.md body — writing the self-introduction body densely with concrete vocabulary is what helps most. If the cache is absent it is built automatically during ask, and changes to a local vault's VAULT.md are detected by hash and only that vault is re-embedded, so you need not run world-refresh by hand day to day (it is for when you want to rebuild in bulk, e.g. right after adding a vault to world.json). An actual query against another vault happens only when the caller runs `ask "<question>" --vault <path>` (the hint's `ask_command`) — never automatically.
