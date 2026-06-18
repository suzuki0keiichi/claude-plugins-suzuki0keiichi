# Schema Quick-Reference — system vault

Canonical source: `graphrag/schema.ts`. This file covers the **system** preset (default).

## Node Types (13)

- No root node type (removed in v3.3). **Scope = vault boundary itself** (vault=scope).
- **`File`**: Indexed source file. `summary_provisional: true` means the summary is still a machine template — read the file and rewrite to a real summary (primary retrieval quality lever).
- **Knowledge (8)**:
  - `Decision` = Chose one option among alternatives.
  - `OperationalKnowledge` (abbr. OK) = Learned through operation. **Criterion: chose from alternatives → Decision; learned from operation → OK. When unsure, use Decision.**
  - `RejectedOption` = Considered and rejected alternative. First-class node to prevent repeating the same mistake.
  - `Constraint` = Immutable external condition (law, SLA, technical limitation).
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

## Edge Types (14)

- `documented_by`: Decision|RejectedOption|Risk|OK|Investigation|Deliverable → File
- `evidenced_by`: Layer|Concern|Component → File
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

Example: a component node `component:web-auto:fms` with `vault_ref: "fms"` means "the fms subsystem is described in the fms system vault". Cross-vault edges can then use the `vault:<slug>/...` ref syntax to link knowledge across vault boundaries.

`vault_ref` is a convention only — no schema validation is applied. The validator ignores unknown extra attributes on nodes.

## vault_slug_aliases — renaming a vault slug without breaking refs

If a system vault needs to be renamed, add the old slug(s) to `vault_slug_aliases` in its VAULT.md:

```yaml
---
name: FMS
kind: system
vault_slug: fms
vault_slug_aliases:
  - fleet-management-system
---
```

The cross-vault resolver accepts both the current `vault_slug` and any alias. New refs **must** use the current slug; `xref-check` warns when a ref uses an alias instead of the current slug.

## ID Convention

`<typeSlug>:<system>:<slug>` (e.g. `decision:graphrag:vault-single-source`).

## State Vocabulary

| Type | Allowed states |
|---|---|
| `Investigation` | `"active"` \| `"closed"` |
| `Decision` / `OperationalKnowledge` | `"superseded"` only (no state = current) |
| `Goal` | `"planned"` \| `"active"` \| `"achieved"` \| `"abandoned"` |

## Policy Reversal Recipe

1. Create new Decision, add `refines`: new→old (lineage).
2. Update old Decision to `state: "superseded"`.
3. Optionally create RejectedOption and wire `supersedes`.

Incoming `has_premise` edges to old node survive (lineage preserved). Plan template: `mutation-templates.md`.
