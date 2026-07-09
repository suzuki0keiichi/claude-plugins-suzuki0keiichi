# Topology Gap Review (graph-structure self-reflection on bug / oversight discovery)

When a bug or an overlooked case is found, ask yourself:

1. **Could this have been avoided if the graph had the right structure?** — If the Concern/Component or edge that ought to exist had been there, would `ask` have pulled that Constraint/Risk and prevented the bug?
2. **Is a node that should exist missing?** — Is an existing Constraint/Decision simply not reaching another operation path (an edge hole), or is the crosscutting concern (Concern/Component) not structured in the first place?

**Hole pattern**: Constraint C is correctly applied to operation A, but the graph has no C→R→B path to operation B, which touches the same resource R. The cause is the absence of a Concern/Component representing R, or a missing edge into it.

**When it applies**: fill the missing structure (Concern/Component + edges) via `commit-mutation` so that future `ask` prevents the same kind of oversight. This feedback closes the graph's learning loop — not improving search precision, but cultivating the graph's topology itself.

**Timing**: on bug fixes, addressing review comments, or when the user asks "why couldn't this be pulled from the graph?" Similar to Drift Reconciliation, but this deals with "the absence of structure that should be written into the graph" rather than "the staleness of content written in the graph."
