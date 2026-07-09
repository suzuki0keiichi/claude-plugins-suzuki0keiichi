# Concept carving quality rules

Whereas `conceptual-pass.md` specifies *what* to carve and *which edge* to connect it with,
this file specifies the quality guards for *how to carve* and *how to finish*. Every
conceptual-pass that mutates a Component / Concern / Layer must satisfy these rules. A
violation is a carving defect even if it passes `validateGraph`, and directly harms retrieval
quality and future followability.

> The axis-2 (crosscut structure) node types are canonically **Component = a locally cohesive
> structural cluster** (alias: Component), **Layer = a horizontally stacked architectural
> layer** (alias: Layer), **Concern = a crosscutting concern that runs through the layers**
> (alias: Concern). The geology-metaphor names remain as aliases for compatibility. This file
> is written with the canonical names.

## Why quality rules are needed (design rationale)

Final conclusion of `docs/history/indexer-redesign-notes.md` (historical): the ceiling on
retrieval quality was not model capability but "interpretation guidance + use of the graph
signal (role)." The same applies to carving. The candidates the indexer emits (dependency
community, topology depth, naming) are a deterministic scaffold; what ultimately gets named a
Component / Concern / Layer is the LLM's judgment. Without a judgment axis:

- Related terms get dragged along and a mega-component is born (e.g. 38 files in one).
- Crosscut intent and local responsibility get double-represented under the same concept
  (a `Component` and `Concern` overlap).
- Numeric numbering lingers and no meaningful slug is attached (`c1`–`c9` numbering,
  missing-number accidents).
- Follow-up is missed when a new directory is added (orphaning of `core/backup/` etc.).

Even if found after the fact, these cannot be fixed without re-carving. Passing them through a
quality gate at the carving stage is the cheapest.

## Component carving

### Same-directory principle (default)

When the member Files of a candidate Component are gathered from the same directory, by default
confirm them as-is as one Component. The `evidenced_by` grounding also lines up per directory.

When bundling Files from different directories into the same Component, always put **a
one-sentence justification of "why bundle them" into the Component's `summary`**:

- Good: 「`core/cloud/` の I/O 群と `server/routes/network` の HTTP 受け口を共に Web.Auto への
  外向き接続として束ねる」.
- Bad: bundling `core/cloud/`, `core/pipeline/`, and `core/scanner/` as 「I/O 系」 with no
  justification (= a sign of lumping different responsibilities together).

If you get stuck trying to write the justification, that is a sign they should not be bundled.
Split them.

### Granularity guard

| Situation | Response |
|---|---|
| Under 4 files | Almost a "box" state. Re-evaluate for double representation with a Concern, or whether it can be absorbed into a larger Component |
| 4–20 files | Standard granularity. Confirm as-is |
| Over 20 files (including tests) | Possibly multiple responsibilities mixed in. Splitting along functional lines is mandatory to consider |
| Over 30 files | Almost certainly a composite of multiple Components. If not splitting, a strong justification in `summary` |

Judge granularity by "cohesion of responsibility," not "file count." File count is merely a
trigger threshold for re-evaluation.

### Foreign-body inspection (required)

Do not mix in member Files that are **clearly unrelated by path / filename** to the
responsibility indicated by the Component's `title` / `summary`. Inspection procedure:

1. Read the Component's `title`.
2. Look at the 1st–2nd path level of each member File (e.g. `core/pipeline/`, `core/scanner/`).
3. If that path falls outside the domain indicated by the `title`, move it to a different
   Component.
4. Generic files like `logger.ts` / `utils.ts` directly under `core/` are treated as
   allowed-orphan, belonging to no Component (excluded by the coverage gate; see below).

Good: the members of `title=「クラウド I/O」` line up as `core/cloud/*`,
`server/cloud-endpoints.ts`, `server/routes/network.ts`, `server/routes/settings.ts`.

Bad: `core/pipeline/compress-worker.ts` and `core/scanner/rosbag-info.ts` mixed into the same
Component. These are clearly a different domain by path.

### Handling single-file responsibilities (absorb / 1-file Component / allowed-orphan decision flow)

The decision when "a responsibility with only 1 file in its directory" or "an isolated
generic/constant/type file" appears. **To prevent overproduction, try from the top in order**
and settle at the earliest stage that decides. The LLM must not "just create one" to avoid
step 4 (= stop with strong will).

```
1. Can it be absorbed into an existing Component under a "same-domain narrative"?
   = Does including this file stay consistent without rewriting the existing Component's title/summary?
   YES → add `evidenced_by` to the existing Component (absorb). 【top priority】

   Example: the single file `core/backup/backup-manager.ts` — if it is consistent with the
       narrative of the existing `device-pipeline` Component
       (「device 検出 → scan → backup/compress/upload pipeline」), absorb it. Always try this
       before carving a standalone 1-file Component.

2. Even for 1 file, can you write its own **domain narrative?**
   = Can you write title + summary in one sentence as "what responsibility this file holds,"
     without overlapping an existing Component, and can you say that future same-domain files
     will gather here?
   YES → you may create a new 1-file Component. (= allow a 1-file Component for coverage)

   Good: single file `luks-manager.ts` → title=「LUKS パーティションのアンロック管理」,
           if there is future `unlock-luks`-family expansion it gathers here; narrative holds.
   Bad: single file `string-helper.ts` → title=「文字列 helper」 has a weak narrative
           → do not make it a 1-file Component; go to step 3.

3. Is it common infrastructure that none of the above fits (constants / types / composition
   root / generic utility), or a test for those?
   YES → **permitted to leave as allowed-orphan** (orphan is fine).
         But the principle "if step 1 can absorb it, prefer absorption" is unchanged.
         allowed-orphan means "allow it to stay orphan," not "force orphan."

   Example: `server/index.ts` is a composition root, but if its narrative is consistent with
       an 「Express サーバと API ルート」 Component, you may choose absorption (step 1).
       Conversely, if its narrative is a bundler spanning multiple Components, leave it as
       allowed-orphan.

4. None fit / unsure
   → **STOP**. Do not create a new one. Escalate the decision to the user.
     The judgment between "this is not a Component" and "making it a new Component is
     warranted" is decided on the user side with strong will. The LLM stops so it does not
     become "when unsure, create."
```

### Handling constant files (philosophy)

**Avoid creating files that collect only constants**, like `constants.ts` / `enums.ts`. Write
constants directly inside the domain file that uses them (= prioritize domain cohesion).

Files like `shared/constants.ts` that already exist for historical / sharing reasons are
tolerated as allowed-orphan, but these are an "unavoidable fallback," not a desirable state. If
you are about to create a constants file in newly added code, first consider "whether it can be
written inside a domain file."

### Meaningful naming required (common to Component / Layer / Concern; no placeholders)

**This rule applies equally to all three crosscut types (Component / Layer / Concern).** The
indexer attaches machine-placeholder id / title / summary to candidates
(`component:<sys>:c1` / `layer:<sys>:band0` / title `"Layer band 0/3 (41 files)"` /
`"Component candidate c1"` etc.). These are **constituents of the members (the bundled Files,
the dependency-depth band, the sequential number), not meaning** (§0 grand principle). Carving
is **replacing these machine names with meaningful naming of "what that node is responsible
for."**

**id slug — always meaningful kebab-case.**
- Good: `component:<sys>:cloud-io` / `layer:<sys>:foundation` / `layer:<sys>:domain-logic` /
  `concern:<sys>:auth-access`
- Forbidden: `c1` / `c2` … (Component sequential numbers), `band0` / `band1` … (Layer sequential
  numbers). Always rename the indexer's machine IDs to meaningful slugs before persisting.

**title — always meaningful words. Leave no trace of the machine placeholder.**
- Good (Layer): `基盤層 — 設定・データ・共有型の土台` / `入口・合成層 — 起動とルーティング合成`
- Good (Component): `サーバ中核(設定/DB/認証/WS)` / `共有UI部品`
- **Forbidden (do not confirm as-is)**: titles containing **a dependency-depth band, candidate
  sequence number, or file count**, like `Layer band 0/3 (41 files)` / `Component candidate c1` /
  `(7 files)`. File count and band number are constituents; they express nothing about "what"
  that layer/cluster is responsible for.

Rationale: sequential numbers cause missing-number accidents on future addition/deletion (`c6`
alone is deleted and it becomes meaningless). Names carrying a file count or band number are no
semantic clue in retrieval, and the name becomes a lie the moment members increase or decrease
by one. Meaningful naming does not collide, retains meaning in history even when deleted, and
works in search.

**Enforced at the gate**: `carving-check` stops residual candidate:true with a
`candidate-uncarved` ERROR, and placeholder traces in the title (`band N/M` / `(N files)` /
`candidate cN`) with a `placeholder-title` ERROR. A sequential slug is a `meaningful-slug` WARN.
**Carving complete = the state where these are 0.**

### No laundering a Constraint as a Decision

Do not disguise a broad-scope invariant by writing it as a Decision and wiring it crosscut with
`sets_policy_for` (= laundering a Constraint as a Decision). A crosscut-altitude constrains does
not exist in the grammar. When there is no altitude, enumerate the Files + state the scope
explicitly in the summary.

Rationale: a Constraint is "an invariant that must not be broken," a Decision is "a chosen
judgment (supersede-able)" — different semantics. Disguising the type means it is missed when
you retrieve "constraints to uphold," and it wrongly rides on the target of the policy-reversal
recipe (supersede). Like naming, the type too carries the node's **meaning**.

### Retirement and naming stability

Do not delete a confirmed slug to free it up. A Component being retired:

- If deleting with `op:"delete"`, write 「`<旧 slug>` を吸収」 in the successor Component's
  `summary`.
- If only renaming, prefer `op:"update"` patching only `title` / `summary` rather than new
  creation + old `op:"delete"` (since the id including the slug is immutable, if a naming change
  is truly needed it becomes new creation + old deletion, in which case leave the history in the
  summary).

**Retirement of a knowledge node (Decision / OperationalKnowledge) is state, not deletion**
(`state:"superseded"`). The source of truth for the policy-reversal recipe (create new Decision
→ `refines` new→old → mark old superseded) is `mutation-templates.md` "Policy reversal."

## Concern carving

### Qualitative difference from Component / Layer

Component is a dependency community, Layer is a topology-depth band — for both, the indexer
emits candidates deterministically and the LLM handles naming and meaning-assignment. Process
the candidates and a result comes out.

**Concern has no such scaffold.** Authentication, observability, error handling, encryption,
i18n, auto-update — these do not surface within the import graph as a "crosscutting-concern
cluster." Discovering and defining a Concern **has the LLM's conceptual modeling as the
protagonist**, the step demanding the most emergent understanding in all of carving. An
approach of "process candidates and name them," in the same spirit as Component / Layer,
overlooks many of the crosscutting concerns that should exist.

Perform Concern carving in this order: first the LLM models crosscutting concerns from the
whole picture, then machine signals fill in blind spots, and finally quality rules finish it.

### LLM modeling (primary)

Once structure is visible via Component / Layer, survey the whole codebase and pose these
questions:

- **Given the nature of this system, what crosscutting concerns run through it?**
  Look from both sides: domain-specific crosscutting concerns (audit trails for finance, PHI
  access control for healthcare, etc.) and general software crosscutting patterns
  (authentication/authorization, observability, error handling, configuration management,
  encryption, i18n, auto-update, etc.).
- **What common motive runs through the existing Components / Layers?**
  When the same "why" is scattered across multiple Components, that is a Concern.
- **What crosscuts in a functional sense, not biased toward a particular tech stack?**
  Example: LUKS spans 6 tech stacks — TypeScript / Express / React / Bash / systemd / udev —
  appearing in neither the import graph nor embedding proximity, yet it crosscuts under the
  motive of "data encryption." Theme words in the path / filename are the clue.

### Blind-spot check via machine hints (supplementary)

After LLM modeling, cross-check against the machine signals below to pick up oversights.
**These are a verification, not a starting point.** A crosscutting concern the machine did not
emit is not necessarily nonexistent.

**`concern-hint` (embedding-proximity clustering)**: builds a k-NN graph from each File's
embedding and clusters semantically proximate file groups belonging to different Components via
Union-Find. Presents each cluster as candidate JSON (member_files / spanning_components /
theme_words). Reconsider if there is a candidate not included in the LLM modeling. Recommended
parameters: `--threshold 0.92 --knn 1 --min-cluster 3 --min-span 2` (adopts a k-NN graph to
suppress a giant component; a low threshold causes a connectivity explosion).

**`cross_component_in_degree` (structural signal)**: each File is annotated with "the number of
distinct Components that import it." A file with 2 or more may have a crosscut running through
it. Example: `core/logger.ts` imported from 4 Components → the crosscut of an observability
Concern. But shared types (`shared/types.ts`) and composition roots also get a high in-degree,
so do not decide it is a Concern from the machine signal alone.

### Crosscut condition (≥2 Components)

Only establish a `Concern` that **holds Files spanning two or more Components**.

A responsibility complete within 1 Component is not made a Concern. Absorb it as that
Component's responsibility.

Decision procedure:

1. Take the member Files of the candidate Concern.
2. Tally the Component each belongs to.
3. Only 1 Component → do not make it a Concern; mention it in that Component's `summary`.
4. Two or more Components → promote to a Concern as crosscut intent.

Example: "a React dictionary for i18n (`src/ui/i18n/*`)" alone is a UI-family Component's
responsibility. If it crosscuts to the Windows installer side
(`packaging/windows-installer/workflow/install-messages.ps1`, `msi-maintenance-notice.vbs`),
it is a Concern. Do not double-represent as a Concern + Component with the former alone.

### Concern naming guideline (one level of abstraction)

Prefer **a concept name abstracted one level up**, not the feature name as-is (e.g.
`luks-encryption`).

- Good: `data-encryption` (unifies LUKS and config crypto), `auto-update` (unifies MSI and WSL
  distro updates), `observability` (log + sentry + ui-trace)
- Bad: `luks-management`, `msi-self-update` (stuck to the concrete; future additions require
  renaming)

Rationale: a Concern is a node expressing "motive," and if it carries a specific
implementation's name, same-motive files of another implementation float free (e.g. when AES
encryption is added, it does not fit into a LUKS Concern). Keeping it an abstract word lets you
later absorb "a new implementation of the same motive."

However, excessive abstraction (`security`, `infrastructure`, etc.) breaks the single-motive
principle (secrecy, encryption, validation, and permissions get mixed into "security"), so it
is no good. **One level of abstraction** is the guide.

### Single-motive principle

**1 Concern = 1 motive.** Do not create a catch-all Concern like "security" / "reliability"
that bundles multiple motives. It crosses wires when tracing motives.

Bad: `concern:<sys>:secrets-and-validation` (= secret masking + input validation + persistence
in one). Three motives are mixed, making the reference paths of Risk and Decision hard to
follow.

Good: split it.

- `concern:<sys>:secrets-handling` (motive: preventing leakage of secret information)
- `concern:<sys>:input-validation` (motive: suppressing invalid values from input paths)

### No double representation with a Component

**If you have established a responsibility area as a Concern, do not create a Component holding
the same file group.** And vice versa. Representing the same concept with two node types makes
one go stale when you update the other.

Decision procedure: if the new Concern's member File set ∩ any Component's member File set nearly
matches, suspect double representation. Consolidate to one side:

- If it crosscuts, keep the Concern and retire the Component.
- If it is local responsibility, keep the Component and withdraw the Concern.

## Layer carving

### Naming (name the vertical position in the dependency pyramid by meaning)

The band goes in order from "the most-depended-upon foundation (0)" → "entry point / topmost
(large)." Read what each band is actually a collection of from the member Files' roles
(`role`/summary), and make the **common vertical-position meaning** running through that band
the title/slug (e.g. `基盤層 — 設定・データ・共有型の土台` / `foundation`. Server-family and
web-family coexisting is normal — Layer is the depth axis). The source of truth for the naming
rules (meaningful slug, no placeholders, gate-enforced) is the "Meaningful naming required"
section.

### Scope (only things with runtime dependencies)

A Layer expresses **the vertical position in the dependency pyramid**. What is in scope (= may
be made a Layer member):

- Implementation source (`src/`, `core/`, `server/`, `ui/`, etc.)
- Configuration files (`*.env`, `config/`, build profiles, configuration scripts)
- Packaging / distributables (installers, WSL images, systemd, etc. under `packaging/`)
- Docs required for operation (`README`, `USER_MANUAL`, `INSTALL`, etc., including blueprints
  that code references)

**"May be included" and "required by coverage" are different.** Configuration files (roots,
examples, templates such as `package.json` / `tsconfig*.json` / `*.env*` / lock / workspace /
`.claude/settings.json`) and README may be made Layer members if they naturally fall into the
bottom band through dependency bundling, but **the coverage gate treats them as allowed-orphan**
and does not force membership (source of truth is builtin generic patterns +
`.graphrag/carving.json`; the "Source of truth for allowed-orphan" section). This is because
these are often standalone configs with no dependencies, and forcing layer assignment would be
noise. What is **required** is that implementation files excluding allowed-orphan
(`role=source/test/config`) belong to a Component, and Files under src/packaging belong to a
Layer (the scope covered by `check-carving`'s component-coverage / layer-coverage gates).

### Exclusion rules (do not put in a Layer)

The following are not put in a Layer. They blur the meaning of the Layer hierarchy.

- **plans / handover documents / past-investigation HTML** (`plans/*.html`, `plans/*.md`,
  `plans/backlog*/**`): handled in an Investigation node's `raw_content`. Not a dependency
  target of a Layer.
- **knowhow / hindsight docs** (`docs/knowhow/`): a collection of past cases, not referenced
  from code. Handled as the `documented_by` source of an OperationalKnowledge node.
- **design-discussion / adoption-decision docs**: handled as the `documented_by` source of a
  Decision node. Not made a Layer member.
- **generated artifacts / temporary files** (`generated/`, `dist/`, `node_modules/`,
  `release/`): not indexed.

### Placement of tests (uniform rule)

Place test files (`tests/`, `*.test.ts`) in **the same Layer as the implementation**.

Do not take variations like "create a test-only Layer" or "raise them to the composition
layer." If the rule wavers, tests are missed at crosscut-query time by not being in the expected
Layer.

### Coverage (Layer side)

Every File under src / packaging must **belong to at least one Layer**. A File that does not is
reported as an orphan by the coverage gate (see below).

## Coverage regression gate

A quality gate that must be passed before merging a conceptual-pass. `validateGraph` 0 failures
is a pass condition; this gate comes next.

### Component coverage

**Implementation source files** under `src/` + `packaging/scripts/` must belong to at least one
Component. As an exception, allowed-orphan is explicitly tolerated. The source of truth is two
layers (the "Source of truth for allowed-orphan" section):

- builtin generic patterns (composition root / generic utility / shared definitions / locks and
  manifests)
- entries in `.graphrag/carving.json` (project-specific, human-owned, user-approved only)

If any other File under `src/` is unassigned to a Component, **re-evaluate as a carving defect**.

### Layer coverage

Every File under `src/` + `packaging/` (including tests) must belong to at least one Layer. A
File that does not fall under the exclusion rules (plans / knowhow, etc.) but is unassigned to a
Layer is a carving defect.

### Orphan reporting

After passing the gate, if you leave unassigned Files, **leave the allowed-orphan list in the
mutation plan's `reason` field** (so a reviewer / successor LLM can distinguish it as
intentional exclusion).

## Incremental follow-up (changed / new File)

Respect the `change_status: new|changed|unchanged` of `node graphrag/cli.ts index`:

| change_status | Required action |
|---|---|
| `unchanged` | No conceptual-pass needed. Leave as existing |
| `changed` | Regenerate the File summary (per `interpretation-guidance.md`). Do not change the assigned Component / Concern / Layer as a rule, but re-evaluate carving if the filename or path changed |
| `new` | **Always re-evaluate carving.** See the flow below |

### Flow when a new File arrives

1. Look at the file's 1st–2nd path level.
2. Check whether it can be absorbed into some existing Component under the "same-directory
   principle."
3. Can absorb: just add `evidenced_by` to the existing Component.
4. Cannot absorb (= new directory): carve a new Component. Satisfy the "Granularity guard,"
   "meaningful slug," and "Foreign-body inspection."

### When a new directory is added

When a new directory like `core/backup/` appears, if multiple Files live under it, **make
carving a new Component mandatory** (if only the single file `backup-manager.ts`, consider
absorbing it into an existing Component). Keep it consistent with the default principle of
carving Components per directory.

### On large-scale change

If **half or more** of an existing Component's member Files change, re-evaluate the Component's
`title` / `summary` / granularity. Check whether the old title correctly describes the current
members.

## Automated verification command (mechanizes most of the pre-submission carving check)

`node graphrag/cli.ts carving-check --graph <path>` mechanically verifies most of this file's
rules. ERRORs must be resolved; WARNs require a justification when intentional. It judges the
following items:

1. **meaningful slug**: sequential IDs like `^c\d+$` / `^band\d+$` are warned (both Component /
   Layer)
2. **exclude docs from Layer**: a File with `role === "documentation"` in a Layer is warned
   (structural judgment: trust the indexer's role classification; no whitelist maintenance
   needed)
3. **Component coverage**: a file with `role ∈ {source, test, config}` unassigned to a Component
   and not matching allowed-orphan (builtin generic patterns / `.graphrag/carving.json` entries;
   the "Source of truth for allowed-orphan" section) is an ERROR
4. **Layer coverage**: same as above (documentation / generated excluded)
5. **Component-Concern Jaccard**: on an implementation-file basis, Jaccard ≥ 0.4 is a
   double-representation warning (tests are excluded from the comparison because they belong to
   both Component and Concern and inflate the denominator)
6. **Concern's dominant-Component share**: ≥ 70% is a "crosscut condition formally holds but is
   substantively single-leaning" warning
7. **indexer signal**: if `cross_component_in_degree` is empty for all Files, a re-index of the
   indexer + a signal-only mutation is needed (info)
8. **multiple Concern membership**: a file belonging to ≥3 Concerns → suspected
   single-motive-principle violation
9. **knowledge-impl-binding-missing**: warns a Decision / OperationalKnowledge / Risk that has
   no `sets_policy_for` or `documented_by` binding to an implementation file. Knowledge bound
   only via knowhow / plans / design-decisions docs cannot be traced on the graph for "which
   code this decision/insight drives." Fill it in via the flow: mechanically extract candidates
   with `node graphrag/cli.ts edge-suggest-policy` → LLM confirmation → `sets_policy_for`
   mutation. **Extension to Constraint (`constraint-binding-missing`)**: a Constraint is WARNed
   if it has not a single `constrains` edge (any target). The judgment for existing D/OK/R is
   unchanged. `add-constraint --constrains <id,...>` requires ≥1, so it is naturally satisfied
   via typed-add (it trips when you create a Constraint with no constrains via commit-mutation).
10. **node-duplicate-suspect**: warns pairs whose embedding cosine similarity between same-type
    nodes is ≥ threshold (default 0.92). The target types are the same single source of truth as
    the write-time duplicate gate (schema's duplicateCheck targets = all knowledge / crosscut
    node types except File / ConversationChunk) — so the audit and gate criteria do not diverge.
    Mechanically detects notation-variance duplicates when "same concept, different naming"
    (e.g. `auto-update` vs `auto-updater`) arises from a worktree merge. Runs only when
    `--vector-index` is specified (skipped as INFO if omitted). After LLM confirmation, unify by
    deleting one + rewiring edges.
11. **exemption accounting**: always prints the breakdown of allowed-orphan exemptions to the
    text / JSON output. Each exemption's grounding kind `builtin:<name>` / `role:<role>` /
    `config:<path>`, the config-derived count, and the exemption ratio among implementation
    Files. Ratio > 15% is a WARN (a sign the coverage gate is hollowed out by exemptions). A
    config entry duplicating a builtin is also a WARN. Invalid carving.json entries (glob / regex
    characters, missing `reason` / `added`) and paths not present in the graph (stale-exemption)
    are ERRORs
12. **knowledge-floor**: if there are 0 Goals, WARN `knowledge-floor-goal-missing` (design-review's
    scope-creep / roadmap perspective is in a disabled state; perform the conceptual-pass
    knowledge-axis seeding). 0 Constraints is the same-shape WARN
13. **superseded-premise**: WARNs a pair where a node not in a terminal state (superseded /
    abandoned / closed) `has_premise` to a node in a terminal state (detection of a dead premise;
    prompts either rewiring to the successor node, or confirming whether the premise is really
    still alive; does not exclude = visualization only)
14. **knowledge-description-missing**: lists as WARN the Decision / RejectedOption / Constraint /
    Goal / Risk / OperationalKnowledge nodes missing a `description` (the message notes the
    reason: the embedding's semantic carrier is thin). Because summary alone thins the embedding
    and makes it harder to retrieve, write a meaningful description on every node as a rule
    (`conceptual-pass.md` §0 grand principle / the summary-vs-description split in SKILL.md's
    Mutation Plan). From typed-add, specify it with `--description "..."`.
15. **superseded-no-successor**: WARNs a node that is `state: superseded` yet has not a single
    `refines` from a successor (detection of a forgotten wiring in the policy-reversal recipe;
    the "superseded — check successor" state_note becomes a dead end). Either wire a `refines`
    from the successor Decision, or, if the supersede is wrong, withdraw the state.

Note: the **summary-provisional** ERROR (the summary remains a machine template;
conceptual-pass.md §0) exempts packaging / generated / lockfile Files (already excluded from
embedding and not subject to the meaningful-summary requirement — reported as an INFO count, not
an ERROR; rewriting is optional).

### Rationale for thresholds

- Jaccard 0.4: with 2 of 2 implementation files matching + 2 tests (non-implementation) on the
  Component side, around `2/(2+2)=0.5` is the "nearly the same" boundary. After excluding tests,
  lower the threshold one more step to 0.4 (= the state where only 1 of 3 files differs) as the
  "suspected double representation" boundary
- Dominant-Component share 70%: "6 of 8 files in a single Component" is 0.75 and subject to
  warning. Looser than this would unfairly reject a "feature-set-type Concern" (one that should
  properly concentrate in 1 Layer)

### Source of truth for allowed-orphan (builtin generic patterns + .graphrag/carving.json)

The source of truth for exemptions that are not warned even when unassigned to a Component (=
common infrastructure matching step 3 of the "single-file responsibility decision flow") is two
layers. But in either layer, if step 1 (= absorption into an existing Component) holds
narratively, you may choose absorption rather than leaving it allowed-orphan.

**Layer 1: builtin generic patterns (built into the code)** — keep only "things that
structurally belong to no Component in any project" (the criteria are made explicit in code
comments):

- composition root (bundlers like `services.ts` / `App.tsx` / `main.tsx` / `server/index.ts`)
- generic utility (`logger.ts` / `utils.ts`)
- shared definitions (`shared/types.ts` / `shared/constants.ts`)
- locks and manifests

Patterns of specific-project origin (windows-shell / winsw / `*.utf8.bat` / `ui/index.css` etc.
that were in the old hardcoding) have been removed from builtin. If such an exemption is needed,
write it in the layer-2 carving.json. Exemption by role is only the clearly non-implementation
closed set (documentation / generated). config / entrypoint-family roles are exempted only in
AND with a builtin generic pattern (not exempted by role alone).

**Layer 2: `.graphrag/carving.json` (project-specific, human-owned)**:

```json
{ "allowed_orphans": [ { "path": "<literal path>", "reason": "<required>", "added": "YYYY-MM-DD" } ] }
```

- literal path only. An entry containing glob / regex characters (`*` `?` `[`) is an ERROR.
- an entry with a path not present in the graph is an ERROR (stale-exemption; forces cleanup).
- missing `reason` / `added` is also an ERROR.
- `carving-check` reads it via `--config <path>` or convention-resolution from the graph path
  (`.graphrag/carving.json`).

**carving.json is a "human-owned conceptual layer" on par with Layer / Concern / Component.**
The LLM may only propose; additions come after user approval. **An addition to carving.json is
not a substitute for step 4 (STOP / user judgment) of the single-file responsibility decision
flow** — on reaching step 4, take the user's judgment, and only add when the user approves the
exemption. In a review where the diff includes a carving.json change, promote the exemption
addition to findings for human adjudication (see `graph-review-method.md`).

Edit via the `carving-allow` verb (an atomic write sharing the vault-lock; inside a git repo it
attempts git add+commit, failure being non-fatal and noted in the output):

```sh
node graphrag/cli.ts carving-allow add --path <p> --reason <r>
node graphrag/cli.ts carving-allow remove --path <p>
node graphrag/cli.ts carving-allow list
# output graph Files matching the removed old builtin patterns as proposed config entries
node graphrag/cli.ts carving-allow migrate --graph <path>
```

**test-linkage rule**: the test (`*.test.ts` / `*.test.tsx`) of an implementation file that is
allowed-orphan under the above (builtin / config) is likewise treated as allowed-orphan.
Example: if `logger.ts` is allowed-orphan, `tests/unit/core/logger.test.ts` is also
allowed-orphan. This is a natural extension of the "tests belong to the same Component as the
implementation" rule (Layer carving section).

If any other implementation file not belonging to a Component remains, it is an ERROR (=
escalate to user judgment at step 4 of the "single-file responsibility decision flow").

## Pre-submission carving checklist

Before applying a mutation plan with `node graphrag/cli.ts commit-mutation <plan.json>`, confirm
it is not a carving defect (`commit-mutation` writes to the canonical vault via the vault
writer):

**Component**
- [ ] Each Component's id is a meaningful slug (not sequential)
- [ ] Each Component's member File count is standard granularity 4–20, or is in a state where
  its own domain narrative can be written as a 1-file Component (step 2 of the "single-file
  responsibility decision flow")
- [ ] The responsibility indicated by each Component's `title` / `summary` is consistent with
  the member Files' paths (no foreign body clearly of a different domain by path)
- [ ] When bundling Files from different directories, a one-sentence justification is in the
  `summary`
- [ ] When adding a single-file responsibility, evaluated in the decision-flow order step 1
  (absorb into existing) → 2 (1-file Component) → 3 (allowed-orphan) → 4 (stop / user judgment),
  and anything reaching step 4 is confirmed only after taking the user's judgment (do not create
  a new Component on the LLM's sole judgment)

**Concern**
- [ ] Each Concern's member Files crosscut ≥2 Components
- [ ] Each Concern has only 1 motive (no bundling of multiple motives)
- [ ] No Component with the same file set exists in parallel

**Layer**
- [ ] No plans / knowhow / design-discussion docs are included
- [ ] Tests are in the same Layer as the implementation
- [ ] No `dist/` / `node_modules/` / `generated/` are included

**Coverage**
- [ ] All Files under `src/` belong to a Component except allowed-orphan
- [ ] All Files under `src/` + `packaging/` belong to a Layer except those matching the
  exclusion rules
- [ ] allowed-orphan is stated explicitly in the mutation plan's `reason`
- [ ] Exemption additions to `.graphrag/carving.json` are user-approved (LLM proposes only; not
  a substitute for step 4 STOP)

**Incremental**
- [ ] Files with `change_status: new` have been re-evaluated for carving
- [ ] On adding a new directory, new-Component carving is complete, or the reason for
  existing-absorption is stated explicitly in `reason`

Apply only once all checklist items are OK. If even one item is violated, re-carve.
