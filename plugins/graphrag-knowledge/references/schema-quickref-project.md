# Schema Quick-Reference — project vault

Canonical source: `graphrag/schema-project.ts`. Selected by `schema: project` in VAULT.md.
For time-bounded initiatives (business projects). Differences from system vault: File→Source, Layer/Concern/Component→Theme, adds Stakeholder/Resource/Milestone/Assumption/Agreement/Task. **Deliverable lives in system vault — reference via cross-vault ref.**

## Node Types (16)

- **Knowledge (inherited from system, 8)**:
  - `Decision` = Chose one option among alternatives.
  - `OperationalKnowledge` (abbr. OK) = Learned through operation. **Shines for recurring projects** (annual budget, annual event).
  - `RejectedOption` = Rejected alternative.
  - `Constraint` = Immutable external condition.
  - `Goal` = Purpose / target. **Two-layer pattern recommended**: vision Goal (stays active) + gate Goal (achieved/abandoned), connected by `refines`.
  - `Risk` = Threat. **No state** — mitigation via `reduces_risk` edge. "Blocked" = Risk + `risks_in → Task`.
  - `Investigation` = Purposeful inquiry (state: active/closed).
  - `ConversationChunk` = Raw dialogue record.
- **Project-specific (8)**:
  - `Source` = External information source (URL + freshness). Attributes: `source_kind` (document/event/regulation/incident), `url`, `fetched_at`, `refresh_method`, `staleness_threshold`.
  - `Theme` = Cross-project concern (cost reduction, cross-team infrastructure migration, etc.). Often unnecessary within a single project. A theme's footprint in a project is a Goal (active response) or a Constraint (imposed boundary) — not every theme spawns a goal.
  - `Stakeholder` = Interested party. Person, team, or external org.
  - `Resource` = People, assets, money, time. Attribute: `category` (people/budget/asset/time).
  - `Milestone` = Time-axis checkpoint. Grounds Goal in time.
  - `Assumption` = Premise / hypothesis. Attribute: `certainty` (Established/Expected/Assumed/Speculative). Build assumption trees with `has_premise`.
  - `Agreement` = External commitment. Track negotiation progress via state. No backward transitions — expire old, create new.
  - `Task` = Judgment-relevant work unit. Do NOT put Jira-ticket-level items.

## Edge Types (22)

### Provenance
- `documented_by`: Decision|RejectedOption|Risk|OK|Investigation|Agreement → **Source**
- `derived_from`: Decision|RejectedOption|Risk|OK|Goal|Assumption|Task|Investigation → ConversationChunk|Investigation|**Source**

### Judgment / Knowledge
- `supersedes`: Decision|OK → RejectedOption
- `has_premise`: Decision|OK|Risk|**Task**|Goal|**Assumption** → Decision|Constraint|Goal|OK|**Assumption**|**Agreement**
- `refines`: Decision|OK → Decision|OK / Goal → Goal / **Task → Task**
- `led_to`: Investigation → Decision|RejectedOption|OK|Risk
- `triggered_by`: Investigation → Risk|**Source**|ConversationChunk|**Assumption**|**Stakeholder**
- `rejected_in`: RejectedOption → Investigation

### Constraint / Risk
- `constrains`: Constraint|**Agreement** → Decision|**Task**|Goal|OK
- `risks_in`: Risk → **Task**|Goal|**Milestone**
- `reduces_risk`: Decision|**Task**|OK → Risk

### Planning Structure
- `achieves`: **Task** → Goal
- `depends_on`: **Task → Task** / **Milestone → Milestone**
- `targets`: **Task**|Goal → **Milestone**
- `falls_back_to`: **Task → Task** / Goal → Goal (PlanB, chainable)
- `requires`: **Task** → **Resource** (`period_start`/`period_end`/`allocation` optional attrs)

### Stakeholder
- `concerned_with`: **Stakeholder** → Goal|Decision|Risk|**Task**|**Milestone**|**Theme**
- `responsible_for`: **Stakeholder** → **Task**|Goal|**Milestone**|**Agreement**
- `party_to`: **Stakeholder** → **Agreement**

### Crosscut
- `encompasses`: **Theme** → Goal|Decision|Risk|**Task**|**Resource**|**Assumption**|**OK**|**Constraint**
  - Milestone is deliberately NOT a member: a milestone belongs to a theme only via the Goal it grounds (Theme → Goal → `targets` → Milestone), never directly. OK/Constraint can be *primary* members (knowledge or a boundary condition can itself be the theme's subject); a milestone never is.

### Infrastructure
- `discussed_in`: ConversationChunk → Investigation
- `temporary_relation_candidate`: any knowledge node → any knowledge node

## Cross-Vault Ref

Edge `to` field accepts `vault:<vault_slug>/deliverable:<system>:<slug>`. Local existence check and type-pair check are skipped for `vault:` prefixed targets.

Common patterns:
```json
// Task requires a specific Deliverable
{ "type": "requires", "from": "task:proj:integration", "to": "vault:platform-x/deliverable:platform-x:product-v2.0" }

// Goal targets a Deliverable ("we run on this version" / "we aim for this release")
{ "type": "targets", "from": "goal:proj:demo-on-v4", "to": "vault:platform-x/deliverable:platform-x:product-v1.5" }

// Goal depends on a Deliverable being ready (stronger: if it breaks, goal is at risk)
{ "type": "has_premise", "from": "goal:proj:launch", "to": "vault:platform-x/deliverable:platform-x:product-v2.0" }
```

## ID Convention

`<typeSlug>:<system>:<slug>` (e.g. `goal:my-project:main-goal`). Convention: `<system>` matches `vault_slug`.

## State Vocabulary

| Type | Allowed states |
|---|---|
| `Investigation` | `"active"` \| `"closed"` |
| `Decision` / `OperationalKnowledge` | `"superseded"` only (no state = current) |
| `Goal` | `"planned"` \| `"active"` \| `"achieved"` \| `"abandoned"` |
| `Agreement` | `"exploring"` \| `"negotiating"` \| `"signed"` \| `"active"` \| `"expired"` |
| `Task` | `"planned"` \| `"active"` \| `"completed"` \| `"cancelled"` |
| `Milestone` | `"planned"` \| `"achieved"` \| `"missed"` |

Risk and Assumption have NO state. Risk mitigation via `reduces_risk` edge. Assumption certainty changes via `certainty` attribute update.

### Assumption `certainty` (required field)

| Level | Meaning | When to use |
|---|---|---|
| `Established` | Confirmed fact | Contractually agreed, measured, historically proven |
| `Expected` | High confidence from evidence | Past patterns, verbal commitments, strong indicators |
| `Assumed` | Unverified premise | Reasonable guess, not yet validated, plan depends on it |
| `Speculative` | Hope or guess | No evidence, wishful thinking, "try and see" |

`certainty` is **required** on Assumption nodes — `commit-mutation` rejects Assumptions without it. When unsure, use `Assumed` (better than empty). Reassess periodically: `Assumed` → `Established` (validated) or `Assumed` → `Speculative` (evidence contradicts).

## Decision Criteria

- Compared alternatives → **Decision**. Learned from ops → **OK**. Immutable → **Constraint**. Unverified premise → **Assumption**.
- Blocked task: do NOT add `blocked` state. Use Risk + `risks_in → Task`.
- Agreement retreat: do NOT reverse state. Expire old → create new at `exploring`.

## VAULT.md Format

```yaml
---
name: <project name>
schema: project
vault_slug: <slug>
vault_slug_aliases:       # optional — list old slugs that still appear in existing refs
  - old-slug
---
```

`schema: project` is required. `vault_slug` is the cross-vault ref namespace.

`vault_slug_aliases` lets you rename a vault slug without breaking existing cross-vault refs. The resolver accepts both the current slug and any alias. New refs **must** use the current `vault_slug`; `xref-check` warns when a ref uses an alias (`"ref uses alias '…', current slug is '…' — update ref to use current slug"`).

## parent — vertical containment between vaults

A sub-project may declare its parent program/project in VAULT.md:

```yaml
---
name: dc-migration-tokyo
schema: project
vault_slug: dc-migration-tokyo
parent: dc-migration-fy26   # this wave is part of the FY26 program
---
```

`parent` is a **containment** relation between *vaults*, not a node edge. Three axes must not be confused:

| Axis | Mechanism | Question it answers |
|---|---|---|
| **Vertical** (containment / hierarchy) | `parent` in VAULT.md | "Which vault is this one *part of*?" |
| **Vertical** (goal alignment) | `refines` (Goal→Goal) + cross-vault ref | "Which specific Goal does this Goal *serve*?" |
| **Horizontal** (crosscut) | `Theme` + `encompasses` | "Which single concern slices *across* many vaults?" |

`parent` is the structural backbone; `refines`/cross-vault refs express *which* parent goal a child serves (it can be a subset, or even a goal owned elsewhere). `Theme` stays for many-to-many crosscuts. Use `parent` only for genuine single-parent containment — a sub-project with its own lifecycle that still rolls up to one program.

**Genuine containment only — not a collective label.** The child must be *literally part of* the parent program, not merely grouped with peers under a name the business happens to use now. A handful of projects the org currently markets together as "X" is **not** a parent: such umbrella names drift with portfolio/business reframing, and wiring them into `parent` makes the backbone churn whenever the grouping is renamed or reshuffled. The test: would the part-of relation survive dropping the product/portfolio name? If it holds only because they're "currently called X together," it's a crosscut → use a `Theme`, not `parent`.

Strict rules (validated by `xref-check`): **single parent** (scalar; lists ignored), **same schema** (a project's parent is a project — `schema-mismatch` otherwise; depending on a system Deliverable is a cross-vault ref, not parentage), **resolvable** (else `orphan`; alias-aware with `alias_warning`), **acyclic / no self-reference** (`cycle` / `self`), and **no lifecycle cascade** — a child project archives on its own top Goal independently of the parent.
