---
name: graphrag-doctrine-wiring
version: 1.0.0
description: 利用プロジェクト自身の設計規約・価値観 (CLAUDE.md の設計原則、コーディング規約、レビュー観点、「one authority per meaning」のような原則) を、注意力で守る散文から、このプラグインの器に接続された形 (Constraint+enforcer / 権威 Decision+語彙指紋 / 配置 Component / pre-commit 配線 / レビュー発注チェックリスト) へ変換する対話ガイド。プラグイン自身は設計思想を持たない — 持ち込まれた思想の配線だけを支援し、原則の中身は一切提案しない。「CLAUDE.md に設計ルールを書きたい」「規約を AI に守らせたい/守られない」「設計原則を graphrag に繋ぎたい」「原則を lint に落としたい」「レビュー観点をどこに書けばいい」で発火。スラッシュ: /graphrag-knowledge:graphrag-doctrine-wiring
---

# Doctrine wiring (connect the project's own rules to machines and delivery lanes)

Converts the project's design rules — as the project states them — from prose that holds only through attention into forms that hold through machines and delivery lanes. For the read/write foundation follow the parent skill `graphrag-knowledge`; `$CLI` = `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts`, `$REF` = `${CLAUDE_PLUGIN_ROOT}/references`.

## The line this skill never crosses

This plugin carries no doctrine (graphrag:see constraint:graphrag-skill-dev:plugin-scope-no-doctrine). The doctrine is the project's; only the wiring is ours. Therefore:

- **Never propose which principles a project should adopt.** If asked "what rules should we have?", answer that this is the project's call, and offer to wire whatever they decide.
- **Never import a default rule set.** There is no starter pack.
- **Never judge a rule's merit.** A rule you privately disagree with gets wired exactly as carefully as one you like.

Why wiring matters (field data behind this skill): a principle written only as prose is enforced by nobody — "one authority per meaning" existed as a core principle in a 4.5-month project while 49 local re-implementations accumulated, and a canonical-side comment declaring "the authority is entry()" was violated by a session that never opened that file. Prose reaches whoever reads it; machines and delivery lanes reach whoever acts. **A principle becomes enforceable only when lowered onto a concrete set** — that lowering is this skill's whole job.

## Conversion table (rule shape → vessel)

Classify each rule the project brings by its shape, not its topic:

| Rule shape (as stated) | Vessel | Wiring |
|---|---|---|
| **Invariant** — "X must always / never hold" | Constraint + enforcement choice | `add-constraint --constrains <target> --enforced-by file:<s>:<path/to/check>` where the check FAILS on violation (write it if it doesn't exist — this is the honest moment: a rule nobody will write a check for is enforced by nobody). Put `graphrag:enforces constraint:<s>:<slug>` in the check. If genuinely no check can express it: `--unenforceable "<why>"` — it stays visibly unguarded instead of silently assumed. |
| **Authority declaration** — "the meaning of X is owned by symbol/file Y" | Decision + vocabulary fingerprint | `add-decision` with `--sets-policy-for` → the authority File, and **aliases carrying the owned vocabulary** (the authority symbol AND the literals it owns, e.g. `ERROR_STATUSES`, `zero_bytes`). delta-check's `authority_echoes` then flags any commit that adds that vocabulary outside its home — the second implementation caught in the act. Distinctive identifiers work as fingerprints; plain lowercase words do not. |
| **Placement rule** — "code for X lives in Y" | Component | Register the Component + `evidenced_by` its member Files (`$REF/mutation-templates.md` §Concern/Component). frame-check and the Write hook then show the map at creation time; no further wiring needed. |
| **Temporary known-broken state** — "until X is done, Y cannot be trusted" | debt-shadow Constraint + Goal | Goal (`state: planned`, `--evidence` → where the work lives) + `add-constraint --premise goal:<s>:<slug> --constrains <the Y side>`. The Goal surfaces where the work is; the Constraint warns whoever touches the untrustworthy side. When the Goal settles, stocktake's `settled-premise` flags the leftover shadow. |
| **Process discipline** — "migrations must remove the old side", "definition of done includes cleanup" | Template + CLAUDE.md + honest statement | This plugin cannot enforce process — it surfaces, the project enforces. Wire what is wireable: point migrations at `$REF/mutation-templates.md` §Staged migration (removal Goal registered in the same plan), put delta-check/frame-check/constraint-check in pre-commit or CI (lines below), and write the discipline itself in CLAUDE.md as the project's own rule. |
| **Review perspective** — "reviews should check for X" | Periodic-review checklist, NOT daily prose | Field data: daily sessions do not pay the cost of open-ended perspectives; deterministic checks are all they reliably run. Write perspectives as the ordering checklist for periodic review events (who runs what, when — e.g. graphrag-pr-review / a roller audit), not as daily-session instructions that will be skipped. |

## Procedure (interactive)

1. **Collect** the rules exactly as the project states them (existing CLAUDE.md text, review comments, spoken principles). Do not rephrase their intent.
2. **Classify** each rule by shape using the table. One prose rule often splits into several vessels (an "authority" rule may yield a Decision + a Constraint + a lint).
3. **Propose the wiring per rule** and ask the project to make the enforcement choice explicitly — enforceable (who writes/owns the failing check?) or honestly unenforceable (recorded reason). Do not soften this: the choice IS the conversion.
4. **Register** via `add-constraint` / `add-decision` / `commit-mutation` (duplicate pre-check first, per parent skill), write the `graphrag:enforces` / `graphrag:see` markers into the code side.
5. **Emit the CLAUDE.md wiring lines** — keep them thin (the knowledge lives in the vault; CLAUDE.md holds the project's doctrine and the check invocations):

```markdown
## <the project's own doctrine section — its words, not this skill's>

Before committing: read the delta-check output (wired into the commit hook).
Pre-commit / CI checks: `$CLI delta-check --strict` / `$CLI frame-check --diff <range> --strict` / `$CLI constraint-check --strict`
Migrations follow the Staged-migration template (removal Goal in the same plan).
Deferred work ("later" / "Step N") is registered as a Goal (state: planned) wired to where the debt lives; if something cannot be trusted until it's done, add the debt-shadow Constraint on the untrustworthy side.
```

6. **Report** what got wired where, what was declared unenforceable and why, and what remains prose-only (process rules the project must hold by its own definition of done).

## Plugin-side asks (the ONE thing this skill does bring up on its own)

This skill never proposes doctrine — but it DOES proactively present the plugin's **operating conditions** (`${CLAUDE_PLUGIN_ROOT}/docs/operating-conditions.md`) at the end of a wiring session, as a separate frame from the project's rules: "aside from your doctrine, here is what the tool itself asks of the project, and which feature dies without each." These are not design opinions; they are the tool's care instructions (a refrigerator maker doesn't tell you what to eat, but does say "keep the door closed"): wire knowledge to files or the read lanes stay empty; write enforcers or constraints stay decorative; include old-side removal in the definition of done; commission periodic audits; keep the verification environment clean; run delta-check over the full range after big squashes; register "later" the moment it is said. Present them with their feature-death causality — the project decides, informed.

## What this skill must never do

- Propose or rank principles; import defaults; judge merit (see the line above).
- Hard-gate anything: every check it wires is advisory or the project's own CI decision. Declining enforcement with a recorded reason is a legitimate outcome.
- Absorb OOP/style vocabularies into the plugin: examples in conversations stay examples; nothing gets baked into templates or checks as "the right design".
- Blur the two frames: the project's doctrine and the plugin's operating conditions are presented separately, never merged into one list (the former is theirs to define, the latter is ours to state).
