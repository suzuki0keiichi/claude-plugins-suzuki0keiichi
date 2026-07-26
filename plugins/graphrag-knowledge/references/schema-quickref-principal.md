# Schema Quick-Reference — principal vault

Canonical source: `graphrag/schema-principal.ts` (mechanical subtraction from `schema-project.ts` — variants may only subtract). Selected by `schema: principal` in VAULT.md.

For the **principal** (当事者): the entity that decides, signs, and bears responsibility — a company, subsidiary, or standing unit. Perpetual lifecycle: the vault never closes on a Goal (withdrawal from a business is a strategic Decision, not a vault closure). Admission test for knowledge: **is the author / signer / allocator of this knowledge the operating entity itself?** Broad usefulness alone is NOT admission — 82% of "homeless" knowledge in real data belonged to system vaults (code-grounded), only ~5% here.

Differences from project: **Task and Milestone do not exist** (time-bounded types). Everything else is inherited unchanged. Zero added types.

## Node Types (14)

Same definitions as project (see `schema-quickref-project.md` §Node Types) minus Task/Milestone:

- **Knowledge (8)**: `Decision` / `OperationalKnowledge` / `RejectedOption` / `Constraint` / `Goal` / `Risk` / `Investigation` / `ConversationChunk`
- **Anchors (6)**: `Source` / `Theme` / `Stakeholder` / `Resource` / `Assumption` / `Agreement`

Notes specific to principal:

- `Goal` = standing intent ("この畑でこの戦略で食っていく"). The project preset's two-layer pattern (vision + gate) collapses here: principal Goals are mostly vision-layer. Time-gated goals belong in a child project vault.
- `Agreement` = standing external commitment (NDA, framework contract, 運用合意). A deadline-shaped promise ("X until 9/30") is a smell — it probably belongs to a project vault.
- `Stakeholder` / `Resource` = thin anchors over external masters (人事・会計・組織図). Never copy numbers — point via `documented_by → Source` and hang judgments on the anchor.

## Rejected types = 型別ルーティングの器側

`validateGraph` rejects Task/Milestone with `unknown node type: Task (schema: principal)`, and `add-task` / `add-milestone` refuse with a routing hint. **Routing time-bounded fragments to the nearest child project vault is the writer's (crawler's) job — the vessel only returns the explicit error.**

## Edge Types (20)

Inherited from project minus `achieves` / `depends_on` / `targets` (their rules empty out when Task/Milestone vanish). Deltas that matter:

- `requires`: **Decision → Resource** only ("this standing policy premises that resource" — e.g. 供給不足を直接契約で埋める方針 → 要員プール). `period_start`/`period_end` attrs rarely apply (standing policies have no period); `allocation` remains useful.
- `falls_back_to`: Goal → Goal only.
- `risks_in`: Risk → Goal only.
- `excepts`: Constraint(例外) → Constraint(原則). See below.
- `documented_by`: from includes **Constraint / Stakeholder / Resource** (+ the project set). A given's grounding is its citation — see 与件 pattern.

Everything else (supersedes / has_premise / refines / led_to / triggered_by / rejected_in / constrains / reduces_risk / concerned_with / responsible_for / party_to / encompasses / discussed_in / derived_from / temporary_relation_candidate) is unchanged from project.

## 与件 (mandate) pattern — how external givens are written

There is **no mandate preset** (rejected 2026-07-26: variants can only subtract, so a mandate preset could never express anything principal cannot; see `rejectedoption:graphrag-skill-dev:mandate-preset`). External givens (law / regulation / standard) are written INSIDE principal (or project) vaults:

1. **The clause itself is never stored.** Its canonical text lives outside (例規集, UN regulation text). Point at it: `Source` with `source_kind: regulation`.
2. **What IS stored is authored by the entity**: interpretation, applicability, gap analysis — `Constraint` (the binding effect on us) / `OperationalKnowledge` (how we operate under it) / `Decision` (our chosen response) / `Risk` (gaps).
3. **Ground the Constraint in its citation**: `Constraint → documented_by → Source`. This is the substitute for `enforced_by` (which does not exist outside system vaults — no test can enforce a law). When the regulation changes, reverse lookup from the Source finds every Constraint to re-examine.
4. Layered norms (法律 → 委任府令 → 解釈運用) = one Constraint per effective requirement, each `documented_by` its own Source; the composite is expressed by `has_premise` between them or prose.
5. A regulator's **verbal/informal position** (根回しで得た当局見解) is `Assumption (certainty: Expected)`, not Constraint.

If regulatory knowledge grows into its own body, carve a **vault instance** scoped to it (schema: principal) — a new address, not a new preset.

## excepts — 原則と確定した但し書き

`excepts: Constraint → Constraint` (from = 例外, to = 原則). Use when a **determinate** carve-out partially defeats a principle — reading either side alone yields a wrong answer ("支払完了したもののみ対象" ⟂ "翌々月払いは条件付きで認められる").

- Exception is **確定** ("認められる") → `excepts`.
- Exception is a **possibility** ("個別に認められる可能性がある") → it is not a Constraint at all; write `Assumption` + `has_premise` toward the principle.
- Do NOT use `refines` (詳細化) for exceptions — an exception defeats scope, it does not elaborate.
- Do NOT split a principle+exception into one merged node ("原則Xだが特例Yあり") — the exception becomes unfindable on its own. One node each + `excepts`.

## State Vocabulary

| Type | Allowed states |
|---|---|
| `Investigation` | `"active"` \| `"closed"` |
| `Decision` / `OperationalKnowledge` | `"superseded"` only (no state = current) |
| `Goal` | `"planned"` \| `"active"` \| `"achieved"` \| `"abandoned"` |
| `Agreement` | `"exploring"` \| `"negotiating"` \| `"signed"` \| `"active"` \| `"expired"` |

Risk / Assumption: no state (same as project). Assumption `certainty` required (same table as project).

## Cross-Vault Ref

Same mechanism as project (`vault:<slug>/<node-id>` in edge `to`). **Principal lives or dies by being referenced**: its value concentrates in other vaults' `constrained-by`-shaped refs (a project consuming a company-wide rule). When bootstrapping a principal vault, deliberately wire ≥1 cross-vault ref from a live project vault and carve ≥1 `Source(regulation)` chain — these are the consumption events that validate the vault.

## VAULT.md Format

```yaml
---
name: <entity name>
schema: principal
vault_slug: <slug>
---
```

`parent` follows the same rules as project (same-schema: a principal's parent is a principal — e.g. subsidiary → 法人). Time-bounded child initiatives are separate project vaults referencing this one, not children via `parent`.

## Decision Criteria

- Chose among options → **Decision**. Learned from operating → **OK**. Binding external given → **Constraint** (+ `documented_by → Source`). Regulator's informal word → **Assumption(Expected)**. Standing commitment → **Agreement**. Deadline-shaped anything → **child project vault**.
- Curation ownership: the vault owner is **whoever retrieves the knowledge most**, not the executive responsible for its content (content responsibility escalates to the board; retrieval ownership does not).
