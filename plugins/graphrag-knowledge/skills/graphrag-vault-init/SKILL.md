---
name: graphrag-vault-init
description: vault (ナレッジグラフ) の初期構築。system vault (コード/プロダクト知識) と project vault (時限イニシアチブ) の両方に対応。「vault を作りたい」「初期構築したい」「新しいプロジェクトを管理したい」「リポジトリを索引したい」で発火。
---

# Vault Initial Setup

Creates a new vault and populates initial nodes. Routes to the appropriate flow based on vault type.

## Prerequisites

- Embedding endpoint must be reachable (Ollama / LM Studio with `nomic-embed-text`).
- CLI launcher: `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts <verb> [args]`

Hereafter `$CLI` = the launcher above, `$REF` = `${CLAUDE_PLUGIN_ROOT}/references`.

## Vault Types — Choose First

| Type | Purpose | Schema | Example |
|---|---|---|---|
| **system** | Code/product knowledge (passive) | `schema: system` (13 node types) | A product platform, an API service, an internal tool |
| **project** | Time-bounded initiative (active) | `schema: project` (16 node types) | L4 approval, API renewal |

**project vault scope**: Goal reaches `achieved` / `abandoned` → vault lifecycle closes (read-only archive). Do NOT create vaults for systems/products or teams/orgs.

---

## System Vault Path

For system vaults (code/product knowledge), use the `carve` command:

```sh
$CLI carve --root <repo-path> --system <system-name>
```

This runs: index → concept extraction → quality gate. See `$REF/indexing-and-carving.md` for the full procedure.

VAULT.md for system vault:
```yaml
---
name: <system name>
schema: system
vault_slug: <slug>
---
```

**The rest of this document covers project vault setup only.** For system vault schema, read `$REF/schema-quickref-system.md`.

---

## Project Vault Path

### Step 0: Create Thin System Vaults for Dependencies

Before creating a project vault, ensure each system vault it will reference already exists with Deliverable stubs. This resolves the chicken-and-egg problem (project vault can't reference non-existent Deliverables).

```sh
# For each system vault the project depends on:
mkdir -p <system-root>/vault/Deliverable
# Write VAULT.md + Deliverable node files (title + summary only, no edges needed yet)
```

### Step 1: Create Directory Structure

```
<project-root>/
  VAULT.md           ← vault profile (sibling of vault/)
  vault/             ← node files go here
```

**VAULT.md placement rule**: `vaultProfilePath()` resolves to `path.dirname(vaultDir)/VAULT.md`. If vault is at `<root>/vault`, then VAULT.md must be at `<root>/VAULT.md` (NOT inside `.graphrag/`). Misplacement causes fallback to system schema.

### Step 2: Write VAULT.md

```yaml
---
name: <project name>
schema: project
vault_slug: <slug>
---
<1-2 line project description>
```

**Required fields:**
- `name`: Human-readable project name
- `schema`: `project` — selects the project schema. **Omitting this causes system schema to be used, which will reject project node types.** A vault's schema is its kind: `system` or `project`.
- `vault_slug`: Cross-vault ref namespace. Short kebab-case. **Immutable once set.**

**Optional fields:**
- `parent`: vault_slug of the single parent program/project this sub-project is contained by. Same-schema, single-parent, *genuine structural* containment only (not a business/marketing grouping under a product name) — see Decision Criteria → "the `parent` field".

### Step 3: Gather Information & Populate — Model Division Strategy

Initial construction has three distinct cognitive tasks. Use the right model for each:

| Phase | Task | Model | Why |
|---|---|---|---|
| **3a. Node extraction** | Extract nodes from information sources (Confluence, Jira, Slack, etc.) | **Sonnet** (subagent) | Pattern recognition / information extraction. High volume, lower abstraction. |
| **3b. Edge modeling** | Wire `has_premise`, `risks_in`, `depends_on`, cross-vault ref edges between nodes | **Opus** (self) | Conceptual modeling. Requires reverse reasoning ("what depends on this assumption?"). |
| **3c. Theme extraction** | Identify cross-vault themes and wire `encompasses` edges | **Opus** (self) | Highest abstraction. Requires seeing patterns across multiple vaults simultaneously. |
| **3d. Gap reification** | Materialize implicit concepts mentioned in Themes/descriptions but not yet nodes | **Opus** (self) | Themes often name shared bottlenecks that Sonnet didn't extract as Resource/Constraint nodes. Ask: "What compute, personnel, facilities, or budget does this Theme's activities consume?" |

**Recommended flow** (from a single Opus session):

```
1. Create directory structure + VAULT.md (Steps 1-2 above)
2. Dispatch Sonnet subagent(s) for node extraction:
   - Provide information sources (URLs, page IDs, documents)
   - Sonnet extracts Goal/Stakeholder/Milestone/Risk/Assumption/Agreement/Constraint/Task/Source nodes
   - Sonnet writes via commit-mutation
3. Review Sonnet's output, then self (Opus) perform:
   - has_premise edges (which Goals/Decisions depend on which Assumptions?)
   - cross-vault ref edges (which Tasks require which system vault Deliverables?)
   - risks_in edges (which Risks threaten which Tasks/Goals/Milestones?)
4. If multiple project vaults exist, extract Themes:
   - Read nodes across all vaults
   - Identify recurring cross-project patterns
   - Create Theme nodes with encompasses edges in each relevant vault
5. Gap reification — for each Theme, check:
   - Does the Theme description mention a shared resource/bottleneck? → create Resource node (category: asset/people/budget)
   - Does it mention an implicit constraint? → create Constraint node
   - Wire requires/constrains edges from existing Tasks to the new nodes
   - This catches implicit shared resources (compute clusters, specialist personnel pools,
     partner capacity) that source documents mention as activities but never name as resources
```

**Why not Sonnet for edges?** Extracting "what this document says" (nodes) is different from reasoning "what conceptual dependency exists between these two nodes" (edges). Sonnet excels at the former but tends to miss reverse-direction implications (e.g., "this Goal has_premise that Assumption" requires understanding that if the Assumption breaks, the Goal is at risk).

**Sonnet delegation: what it CAN and CANNOT do:**

| Sonnet handles well | Sonnet misses (supplement in later steps) |
|---|---|
| Node extraction from source docs | Resource nodes (source docs describe activities, not underlying resources) |
| Extraction-type edges: `achieves`, `targets`, `responsible_for`, `documented_by` | Inference-type edges: `has_premise`, `risks_in` (requires reverse reasoning) |
| Cross-vault ref matching (if given the full ID list) | Cross-vault ref discovery (cannot infer which Deliverables are needed) |
| `certainty` assignment on Assumptions (if given the 4-level definition) | Theme extraction (requires cross-vault abstraction) |

**Sonnet prompt tips:**
- Include a complete mutation plan example (project vault version) — Sonnet's accuracy jumps with concrete examples
- Provide the cross-vault Deliverable ID list from Step 0 system vaults
- Include the certainty 4-level definition: Established (confirmed fact) / Expected (high confidence from evidence) / Assumed (unverified premise) / Speculative (hope or guess)
- For Agreements with source backing: use `raw_content` + `raw_content_status: copied_from_summary` when `derived_from` type pairs don't allow direct linking

#### Information to gather

Collect from Confluence, Jira, Slack, Google Slides, meetings, etc.:

1. **Goal**: What is the project trying to achieve? By when?
2. **Stakeholder**: Who is involved? Owners, approvers, partners
3. **Milestone**: Key checkpoints and dates
4. **Risk**: Known risks
5. **Assumption**: Premises being relied upon (**`certainty` field is required**: Established/Expected/Assumed/Speculative)
6. **Agreement**: External commitments (contracts, grants, partnerships)
7. **Constraint**: Immutable conditions (regulations, deadlines, budget caps)
8. **Cross-vault Deliverable**: Which system vault Deliverables does this project depend on?

### Step 4: Populate Initial Nodes (Sonnet subagent phase)

Use `commit-mutation` for batch creation. All distilled nodes (Decision/RejectedOption/Risk/OK/Agreement) require a `derived_from` edge to a Source or Investigation with `raw_content`.

```sh
$CLI commit-mutation <plan.json>
```

For the full initial-population plan template (Goal / Stakeholder / Milestone / Assumption with required `certainty` / Agreement / Source nodes + achieves / cross-vault `requires` edges), use `$REF/mutation-templates.md` §Initial population.

### Step 5: Verify

Smoke-test retrieval:
```sh
$CLI ask "What is this project's goal?"
$CLI ask "What are the biggest risks?"
$CLI ask "Who is responsible?"
```

**Resource gap audit** — Resources are the most under-extracted node type because source documents describe activities ("data collection", "model training") without naming the underlying resources ("compute cluster", "field engineers"). Run this check:

1. List all Task nodes that have **zero `requires` edges** to any Resource
2. For each, ask: "What physical, computational, human, or financial resource does this task consume?"
3. Create missing Resource nodes (category: people/budget/asset/time) and wire `requires` edges
4. Pay special attention to **shared resources** that multiple Tasks (possibly across vaults) compete for — these are the highest-value Resource nodes for conflict detection

## Schema Reference

For the full project vault schema (16 node types, 22 edge types, state vocabulary, cross-vault ref format), read `$REF/schema-quickref-project.md`.

## Decision Criteria

### "Should this be a vault?"

- ✅ Time-bounded initiative (has start and end) → project vault
- ✅ Independently deployed system → system vault
- ❌ Team / org → NOT a vault (use Stakeholder)
- ❌ Sub-component that doesn't release independently → Component in parent system vault

### "Both nested levels are valid vaults — which one owns a given node?" (the `parent` field)

When a containment relationship holds and **both** the container and the contained legitimately exist as vaults (a subsystem that releases on its own; a sub-project with its own lifecycle), a node can plausibly be filed in either — neither is wrong. A node-to-node edge cannot resolve this, because the ambiguity is about *vault scope*, not about a link. Declare the containment in the child's VAULT.md:

```yaml
parent: <parent vault_slug>
```

This lets a knowledge-gathering crawler choose the **narrowest correctly-scoped** vault for each node instead of guessing. Rules — keep them strict or the tree rots into a junk-drawer pointer:

- **Single parent only.** If you can't name exactly one containing vault, it's not a parent — it's a dependency (cross-vault ref) or a crosscut (`Theme`/`Concern`).
- **Same schema.** project→project, system→system. A project under a system is a cross-vault Deliverable ref, not parentage.
- **Genuine containment, not a collective label.** The child must be *literally part of* the parent, not just grouped with peers under a name the business uses now. "Systems A/B/C are currently sold as product X" is a business framing that drifts when the product is renamed or repackaged — wiring it into `parent` makes the tree churn with org/marketing changes. Test: would the part-of relation survive dropping the product name? If it holds only because they're "called X together," it's a crosscut (`Theme`/`Concern`), not `parent`.
- **No lifecycle cascade.** `parent` is organizational only; archiving stays independent (a child may outlive its parent).
- **Not goal-alignment.** "Which goal does this serve" stays `refines` (Goal→Goal) + cross-vault ref; "which concern cuts across many vaults" stays `Theme`. `parent` is purely *which vault contains which*.

Validate with `xref-check` — it reports `parent` status (`resolved` / `orphan` / `self` / `schema-mismatch` / `cycle` / `unresolvable`).

### "Decision or OperationalKnowledge?"

- Consciously compared alternatives → Decision
- Learned through operation → OperationalKnowledge
- Immutable external condition → Constraint
- Unverified premise → Assumption

### "Goal two-layer pattern"

Vision Goal (stays active) + gate Goal (achieved/abandoned), connected by `refines`:
```
Goal: Strengthen hiring pipeline (active, never closes)
  refines → Goal: Run event successfully (achieved @ 8/23)
  refines → Goal: Send 10 interview offers (achieved @ 8/25)
```

### "How to express blocked?"

Task has no `blocked` state. Create a Risk node for the blocker and connect via `risks_in → Task`.

### "Agreement retreat (negotiation failed, restart)"

Do NOT reverse state. Expire old Agreement → create new at `exploring`. Connect with `supersedes` if appropriate.

### "When does the vault close?"

Top-level Goal reaches `achieved` or `abandoned`. All Tasks are `completed` or `cancelled`. Vault becomes read-only archive. System vault Deliverables live on.
