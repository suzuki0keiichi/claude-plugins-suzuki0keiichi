# Carving rationale (why this schema)

The value of this schema lies not in the enumeration of types but in the carving judgments and the
invariants that support them. Because it is implicitly lost if not written down, it is kept here.
Its origin is the confirmed Decisions of gestalty.

## The node types (13) and why each exists

> At the time of writing there were 12 types. In v3.4 **Deliverable** (a released artifact; the
> destination of cross-vault references from a project vault) was added, making 13 today. Details of
> Deliverable are in `schema-quickref-system.md`.

`NODE_TYPES` in `graphrag/schema.ts`. Axis 2 (crosscutting structure) is named with Layer/Concern/Component.
The geological-metaphor names (Stratum/Vein/Pocket) remain as aliases, and `canonicalType` normalizes them to
Layer/Concern/Component.

### Structural (File)

- The root node types (System / Product / Project / Business) were **removed in v3.3**. Scope is carried by
  the vault boundary itself (vault=scope), and membership by the id convention `<typeSlug>:<system>:<slug>`.
  A root node in the graph was a double representation of scope. The vault's kind will be carried in a future
  vault meta layer (a self-introduction attribute).
- **File**: the minimal structural unit. The main embedding carrier. Symbols/dependencies are held in array
  fields (Symbol is not an independent node — explained below).

### Knowledge (distilled knowledge)

- **Decision**: an adopted design judgment. `supersedes` carries over a rejected option, `refines` an old
  Decision.
- **RejectedOption**: makes a discarded option a **first-class citizen**. Where many ADR-like attempts
  collapse it into a "note" or "decision," "why it was not adopted" is the information a team most loses, so
  it is made independent. Connected via `rejected_in` (rejected in an investigation) and `supersedes` (a
  Decision overrides a rejected option).
- **Constraint**: a constraint to uphold. `constrains` binds Decision/File/OperationalKnowledge.
- **Goal**: the system's final cause / end state (requirement = final cause = end state). Absorbs v2's
  Requirement. `refines` subdivides an upper Goal; grounded to its source via `has_premise` premises and
  `derived_from`.
- **Risk**: a reused risk. `risks_in` ties the target, `reduces_risk` ties a mitigating Decision.
- **OperationalKnowledge**: reused operational insight / workaround.
- **Investigation**: an ongoing/completed investigation. The subject of focus continuity. `led_to` gives rise
  to a Decision.
- **ConversationChunk**: a source conversation memo. The `derived_from` destination of distilled knowledge
  (source required).

### Crosscut

Divides the structure that must survive independently of File structure into 3 kinds:

- **Layer** (alias: Stratum): a horizontally accumulated layer = architecture layer. "Which layer" (vertical
  position).
- **Component** (alias: Pocket): a locally cohesive cluster = a structural unit (package/module root).
  "Where it is" (structure).
- **Concern** (alias: Vein): a thread running through layers and clusters = a crosscutting concern. An
  architectural intent that lives independently of both File structure and layer.
- All 3 kinds point to File via `evidenced_by`. The separation is so that intent does not vanish when Files
  move.

## Why make RejectedOption first-class

Making "rejection" an incidental attribute of a Decision means you can no longer trace "why that option was
not adopted" later. By making it an independent node with `supersedes` / `rejected_in`, you avoid repeating
the same argument on reconsideration. This is not redundancy of information but preservation of the most
perishable information.

## Why Layer ≠ Concern ≠ Component

Three orthogonal axes are directly the basis for carving:

- **Component** is "where it is" (structure). A locally cohesive cluster.
- **Layer** is "which layer" (vertical position). A horizontally accumulated layer.
- **Concern** is "what it cares about crosscuttingly" (intent bound to neither structure nor layer). It runs
  through layers and clusters.
- Collapsing these into one kind means architectural intent dies together with structure on file move /
  refactor.
- Separate the 3 kinds, and rather than hard-coding the determination, pass `judgment_input` to the
  LLM-friendly layer and delegate (candidate via rule score → LLM final judgment). The metrics change per
  port target, so no rules are bundled.

## Why Symbol is not an independent node

Making the symbol/call graph independent nodes + edges would explode the node count on any repository, and a
lightweight indexer without an AST cannot guarantee precision either. The current schema holds symbols/imports
in File array fields and weaves them into the embedding summary (the meaning carrier is a single File). The
Symbol node type and call/reference edges are an intentional non-support out of current scope. If needed in
future, go through agreement on a separate schema extension (do not add to `NODE_TYPES`/`EDGE_TYPES` on your
own).

## The logic of the edge grammar (type-pair rules)

`EDGE_TYPE_RULES` in `graphrag/schema.ts` enforces "what may connect to what." This is the consistency
contract that keeps the graph from turning to soup. Main intents:

- `derived_from`: distilled knowledge → ConversationChunk/Investigation only. Structurally guarantees the
  **source-required contract** (a knowledge node must be traceable to a passing source that holds
  raw_content).
- `evidenced_by`: crosscut (Layer/Concern/Component) → File only. Intent must always be grounded to substance.
- `contains` was **removed in v3.3** (it was the only "organizing edge"). Membership information is already
  held by the vault's existence and the id convention, so it was redundant. The edges that remain in the graph
  are meaning relations only.
- `supersedes`: Decision/OperationalKnowledge → RejectedOption. Fixes the direction of override.
- `led_to`: Investigation → Decision. Preserves the flow of an investigation giving rise to a judgment.

A change that breaks a type pair is dropped by `validateGraph`. This is a structural enforcement written
runtime-independently as a spec, and it works as-is on the port target (the core value of the schema
definition).

## Invariants (contracts contained in the schema definition)

- Source required: distilled knowledge must be traceable to a passing source that holds raw_content.
- Only reused knowledge persists: session-only memos, incomplete gaps, and speculation do not persist.
- Focus-unit scope: session-unit insertion is prohibited (a cause of duplication / fragmentation).
- Prefer skip/update/supersede/review over new creation.
- These are part of the "schema definition." Moving only the type table does not move the value.
