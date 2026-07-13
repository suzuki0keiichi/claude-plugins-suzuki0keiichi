# Schema Quick-Reference — system vault

Canonical source: `graphrag/schema.ts`. This file covers the **system** preset (default).

## Node Types (13)

- No root node type (removed in v3.3). **Scope = vault boundary itself** (vault=scope).
- **`File`**: Indexed source file. `summary_provisional: true` means the summary is still a machine template — read the file and rewrite to a real summary (primary retrieval quality lever).
- **Knowledge (8)**:
  - `Decision` = Chose one option among alternatives.
  - `OperationalKnowledge` (abbr. OK) = Learned through operation. **Criterion: chose from alternatives → Decision; learned from operation → OK. When unsure, use Decision.**
  - `RejectedOption` = Considered and rejected alternative. First-class node to prevent repeating the same mistake.
  - `Constraint` = Invariant to uphold (design invariant, or an immutable external condition such as law/SLA). **Enforcement contract**: a prose-only constraint enforces nothing — wire the executable check that fails on violation via `enforced_by`, or declare `enforcement: "none"` + `enforcement_reason` for genuinely unenforceable external conditions (stays visible as unguarded in `constraint-check`).
  - `Goal` = Purpose / target state (absorbed v2 Requirement).
  - `Risk` = Future threat. Resolution via `reduces_risk` edge (Risk has no state).
  - `Investigation` = Purposeful inquiry (state: active/closed).
  - `ConversationChunk` = Raw dialogue record. Ephemeral episode, no close concept.
- **Crosscut structure (3)**:
  - `Layer` (alias: Stratum) = Depth layer.
  - `Concern` (alias: Vein) = Cross-cutting concern.
  - `Component` (alias: Pocket) = Cohesive implementation unit.
  - Geological names (Stratum/Vein/Pocket) are aliases. **Indexer emits canonical names.**
- **`Deliverable`** (v3.4): Release artifact. Multiple can exist in parallel. Referenced from project vaults via cross-vault ref (`vault:<slug>/deliverable:<sys>:<slug>`).

## Edge Types (16)

- `documented_by`: Decision|RejectedOption|Risk|OK|Investigation|Deliverable → File
- `evidenced_by`: Layer|Concern|Component → File
- `enforced_by`: Constraint → File (**mechanical consumer** — the executable check (test / lint config / type definition) that FAILS when the constraint is violated. Put a comment marker `graphrag:enforces constraint:<system>:<slug>` inside that file; `constraint-check` cross-verifies both directions and hands back ready-made plan fragments for unregistered markers.)
- `targets`: Goal → Deliverable
- `derived_from`: Decision|RejectedOption|Risk|OK|Goal|Investigation → ConversationChunk|Investigation (**provenance** — "where did this knowledge come from". Unlike `has_premise` which is logical dependency.)
- `discussed_in`: ConversationChunk → Investigation
- `led_to`: Investigation → Decision
- `rejected_in`: RejectedOption → Investigation
- `supersedes`: Decision|OK → RejectedOption / Deliverable → Deliverable
- `refines`: Decision|OK → Decision|OK / Goal → Goal
- `has_premise`: Decision|OK|Investigation → Decision|OK|Constraint|Risk|Goal
- `constrains`: Constraint → Decision|File|OK
- `sets_policy_for`: Decision → File|Investigation|OK|Layer|Concern|Component|Deliverable (pick the lowest honest altitude: File→Component→Layer/Concern)
- `reduces_risk`: Decision|OK → Risk
- `risks_in`: Risk → Decision|File|OK|Investigation|Deliverable|Layer|Concern|Component
- `temporary_relation_candidate`: any knowledge node → any knowledge node

## vault_ref — Component pointing to a child system vault

A `Component` node can carry a `vault_ref` attribute that names the child system vault slug where the component's internals live.

| Value | Meaning |
|---|---|
| absent / `null` | Details are described in this vault. |
| `"<slug>"` | See vault `<slug>` for details. |

Example: a component node `component:cloud-svc:billing` with `vault_ref: "billing"` means "the billing subsystem is described in the billing system vault". Cross-vault edges can then use the `vault:<slug>/...` ref syntax to link knowledge across vault boundaries.

`vault_ref` is a convention only — no schema validation is applied. The validator ignores unknown extra attributes on nodes.

## vault_slug_aliases — renaming a vault slug without breaking refs

If a system vault needs to be renamed, add the old slug(s) to `vault_slug_aliases` in its VAULT.md:

```yaml
---
name: Billing API
schema: system
vault_slug: billing
vault_slug_aliases:
  - billing-service-legacy
---
```

The cross-vault resolver accepts both the current `vault_slug` and any alias. New refs **must** use the current slug; `xref-check` warns when a ref uses an alias instead of the current slug.

## parent — structural containment between vaults

A vault may declare a single parent vault in its VAULT.md frontmatter:

```yaml
---
name: payments-fraud
schema: system
vault_slug: payments-fraud
parent: payments-core   # this subsystem is organizationally part of payments-core
---
```

`parent` records a **containment** relation between *vaults* — not a link between *nodes*. It answers "which vault is this one a part of," a fact that no node-to-node edge can carry. Use it when a subsystem releases independently (so it earns its own vault) yet still belongs under a parent system. The payoff is **scope disambiguation**: when a concept could legitimately be filed in either the parent or the child vault, a knowledge-gathering crawler walks the parent tree and files it in the **narrowest correctly-scoped** vault.

**Genuine structural containment only — not a collective label.** `parent` means the child is *literally part of* the parent system. A set of peer systems that the business currently bundles under one umbrella name ("A, B, C are sold as product X") is **not** parentage: that grouping is a business framing that drifts when the product is renamed, repackaged, or reorganized, and baking it into `parent` makes the structural backbone churn with org/marketing changes. The test: would the part-of relation survive renaming the product? If it only holds because they're "currently called X together," it's a crosscut → model it as a `Concern` (shared label over peers), not `parent`.

Strict rules (validated by `xref-check`, surfaced under `parent`):

- **Single parent** — `parent` is a scalar; a YAML list is ignored. If you can't name exactly one containing vault, it has no parent (it's a dependency → use a cross-vault ref, or a crosscut → use `Concern`).
- **Same schema** — a system's parent must be a system (status `schema-mismatch` otherwise). A system is never the parent of a project; that drill-down is the node-level `vault_ref` / cross-vault ref instead.
- **Resolvable** — the parent slug must name a real vault in the world (else `orphan`); alias-aware, with an `alias_warning` when matched via `vault_slug_aliases`.
- **Acyclic, no self-reference** — `self` / `cycle` statuses flag loops.
- **No lifecycle cascade** — `parent` is an organizational pointer only. Archiving is independent: a child can outlive its parent and vice versa. It is NOT an ownership/GC root.

**`parent` vs `vault_ref`**: opposite directions. `vault_ref` lives on a `Component` node and points *down* ("this component's internals are in child vault X"). `parent` lives in VAULT.md and points *up* ("this whole vault is contained by parent vault X"). They are complementary.

## ID Convention

`<typeSlug>:<system>:<slug>` (e.g. `decision:graphrag:vault-single-source`).

## State Vocabulary

| Type | Allowed states |
|---|---|
| `Investigation` | `"active"` \| `"closed"` |
| `Decision` / `OperationalKnowledge` | `"superseded"` only (no state = current) |
| `Goal` | `"planned"` \| `"active"` \| `"achieved"` \| `"abandoned"` |

## Constraint enforcement attributes

| Attribute | Meaning |
|---|---|
| (none, has `enforced_by` edge) | Mechanically enforced — violation fails a check. |
| `enforcement: "none"` + `enforcement_reason` | Declared mechanically unenforceable (external condition: law / SLA / vendor limitation). Stays permanently visible as unenforceable in `constraint-check` instead of silently unguarded. |
| (none, no `enforced_by`) | **Unguarded** — `constraint-check` warns with a wiring prescription. Legacy constraints land here until wired. |

`add-constraint` requires choosing one: `--enforced-by file:<system>:<path>` (repeatable; auto-creates the File node when the path exists on disk) or `--unenforceable "<why>"`. Both at once is rejected. Project vaults are exempt (no File nodes; their constraints are external conditions by nature).

## Policy Reversal Recipe

1. Create new Decision, add `refines`: new→old (lineage).
2. Update old Decision to `state: "superseded"`.
3. Optionally create RejectedOption and wire `supersedes`.

Incoming `has_premise` edges to old node survive (lineage preserved). Plan template: `mutation-templates.md`.
