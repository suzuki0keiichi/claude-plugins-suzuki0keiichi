# Shared method for graph-backed review

The foundation shared by the 3 skills `/graphrag-knowledge:graphrag-design-review` / `:graphrag-pr-review` / `:graphrag-review-doc`.
The three look different but share one root: **"take a change (or proposal) as the starting point, retrieve everything the graph knows about it — bound or not — and interrogate the change with every knowledge type, at the concept altitude, against the human's frame."**
The only differences are input axis and output shape:

| skill | input axis | timing | output |
|---|---|---|---|
| graphrag-design-review | design proposal / approach (knowledge axis = pre-implementation face) | plan / design time | advice (concept-altitude findings) |
| graphrag-pr-review | change diff (crosscut + knowledge axes + File = post-implementation face) | PR / diff time | findings (classified in 3 tiers) |
| graphrag-review-doc | change diff (same as above) | before PR review | human-facing explanation doc (HTML) |

> ※ The section numbers of this reference (§0–§5, including sub-numbers §1.5 / §2.3 / §2.5) are referenced from the SKILL.md of the 3 skills above. When you add / remove / reorder a section, update the referrers (each skill's "method §N" notation) accordingly.

pr-review and review-doc share **almost the same pipeline** (reverse lookup → semantic sweep → forward-expansion coverage → per-type interrogation). The difference is whether the output is findings or a doc.
design-review has no diff to anchor on, so it skips the File-anchored steps (§1.5 / §2 / §2.5); its retrieval is an area `ask` plus the semantic sweep (§2.3, with the proposal as digest source). The per-type interrogation (§3) and the utilization accounting (§4) are common to all three.

---

## 0. Premises (invariants common to these 3 commands)

These follow the design recorded in the vault (retrievable via `ask "グラフを使った PR レビュー層の目的"`):

1. **The goal is controllability, not QA.** AI beats humans at bug detection at the diff level, so hunting for bugs is not the main aim here. The aim is "delegate the broad strokes, but don't cross the frame" — checking that the code has not broken the intent of the concept layer the human owns (knowledge axis + crosscut axis Layer/Concern/Component).
2. **Never hard reject.** A machine cannot decide whether a graph-vs-code divergence means the graph is stale or the code is wrong. So **visualize rather than reject**. The responsibility for fixing (the fix-direction ruling) belongs to the human.
3. **explanation-first.** A finding is written as an explanation — name the concept, quote the norm, show the delta — never as a bare violation line. review-doc goes further: its whole deliverable is the explanation, with violations as annotations inside it. (Gathering the ACK band at the top (§5) does not contradict this: what is gathered there is still explanations, only with higher prominence.)
4. **traceable.** Every finding / claim must trace back to a human-approved knowledge node (with source backing). Do not let AI free-writing be stamped with authorization. Always attach the id of the supporting node to a finding.
5. **Never grep.** "What concepts / history / traps / policies exist" is retrieved via `ask` / `evidence`. Do not read `vault/*.md` or `graphrag/*.ts` directly (conforming to SKILL.md's Anti-patterns).
   This is about the **knowledge-retrieval path**, whereas **reading the code under review (the diff, candidate Files) is in fact an obligation** (§2.5-3).
   Concluding findings from inside the graph alone produces a superficial review, so it is forbidden.
6. **Every knowledge type earns its keep.** The vault does not only hold boundaries (Layer/Concern/Component) — it holds constraints, rejected options, operational burns, open risks, goals, and open questions. A review that checks boundaries and stops has wasted the rest. Retrieval (§2 + §2.3) must give every type a chance to surface, and interrogation (§3) must put a type-specific question to everything that surfaced — with the accounting (§4) proving it happened.

---

## 1. How to invoke the CLI (common to all commands)

```sh
node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts <verb> [args]
```

In a dev environment where the repo was cloned directly, `${CLAUDE_PLUGIN_ROOT}` does not exist, so from the repo root invoke it relatively as
`node --experimental-strip-types graphrag/cli.ts <verb>`.

Verbs used:
- `ask "<question>"` — retrieve concepts / history / traps / policies in one shot (auto-escalation brief→evidence). **Do not repeat-fire.**
  Query wording follows the parent skill graphrag-knowledge's §Query discipline: **mix natural-language terms and code-language identifiers in one query** (knowledge is distilled in natural language while code uses English identifiers — using only one register narrows the hit surface). When the question alone is unlikely to hit, add `--gist "<expected one-liner answer>"`.
- `evidence --request "<title/path>" [--types T1,T2] [--limit N] [--neighbors N]` — trace the neighborhood (governance / derivation) of a specific node, or sweep a type-scoped slice of the vault (§2.3).
  `--types` takes a comma-separated list of **canonical** type names (e.g. `--types RejectedOption,OperationalKnowledge` — aliases like Vein/Pocket do not match).
  **Cannot be looked up by id** (id is excluded from the search target). Confirm the target node via direct_evidence's id / type, then read graph_context.
  Do not adopt results whose `match_confidence` is low/none.
- `carving-check --graph <path> [--vector-index <path>]` — structural gate. In particular, watch **#9 knowledge-impl-binding-missing** (a policy not bound to an implementation).
- `edge-suggest-policy` — machine-extract `sets_policy_for` candidates from Decision/Constraint/Risk → File (for binding completion).

---

## 1.5 Freshness precheck = anchor pass (one call per changed File, reused throughout)

Reverse lookup (§2) implicitly assumes that "the changed Files are on the graph." If the index lags the diff,
every subsequent step silently misses. So **before anything else**, anchor each changed File on the graph — with the one call whose result §2 and §2.5 then read off:

1. Per changed File: `evidence --request "<path of changed File>" --types File --limit 1 --neighbors 2`.
   **Keep each result** — its depth-1/2 graph_context is the raw material of the frame (§2) and of the impact zone (§2.5-1). One call serves all three sections; re-firing it per section is waste, skipping a section because "the call was already made" is the opposite failure.
2. **Confirm the anchor is real**: the returned direct_evidence node's `path` must equal the changed File's path. A fuzzy near-miss (a different File) counts as "not on the graph" — do not adopt a wrong File's neighborhood as this File's frame.
3. **If there is a File not present on the graph**: surface at the **head of the findings** — "the graph does not know this diff (the index is stale). Either bring the index up to date first (the `carve` chain: `index` → rewrite provisional summaries → vector index), or explicitly note this File set as a review blind spot at the top." Do not silently skip.

The cause differs from the binding gap in §4: §4 is "the File is on the graph but no governing policy is bound" (binding gap →
the prescription is bind completion via `edge-suggest-policy`); here it is "the File itself is not on the graph" (index lag → the prescription is the `carve` chain).
Conflating them routes the wrong prescription.

---

## 2. Skeleton of reverse lookup (shared procedure for pr-review / review-doc)

Taking the changed File set as input, assemble the "frame" from the graph. Steps 2–4 are **read off the §1.5 anchor results** (the depth-1/2 graph_context already in hand) — the only new retrieval in this section is the single area-level `ask` of step 4:

1. **Take the changed Files — and read the diff itself**: `git diff --name-only <base>...<head>` for the File list, then the actual diff content (or the current working diff).
   Every later step presupposes the diff has been read: the digests (§2.3), the interrogation (§3) and the corroboration (§2.5-3) are judgments against hunks, not against file names.
2. **Landing point** (crosscut axis): from each anchor's depth-1 `evidenced_by` inflows, read which **Layer (レイヤー) / Component (コンポーネント) / Concern (脈)** the changed File belongs to.
   - Routing signals like "a change entered the UI Layer" surface here (changed File → interface/screen Layer or UI Component).
3. **Governance** (knowledge axis): read the **Decision / Constraint / Risk / OperationalKnowledge that governs** the File and its crosscut parents —
   depth-1 holds the edges addressed directly to the File (`sets_policy_for` / `constrains` / `risks_in` / `documented_by` inflows); depth-2 holds the governance addressed to the crosscut parents **and to the depth-1 governance itself** (e.g. a Constraint that `constrains` the governing Decision) — area-altitude and knowledge-side policy arrives one hop later.
   = "What policies / constraints / risks is this area bound by."
4. **Past history**: around the governance nodes, read the `supersedes` / `rejected_in` / `led_to` edges (related **RejectedOptions**, and how each judgment came to be).
   graph_context truncates (~10 edges/node, ~40 total; policy/lineage edge types are prioritized), so for the narrative it cannot carry, fire **one** area-level
   `ask "<area topic + 1–2 code identifiers> の判断経緯・制約・却下案"` per area — not per node, and never repeatedly. If one specific node's thread is cut off, deep-dive it with a single `evidence --request "<node title>" --neighbors 1` (once or twice at most).
5. **Confirm the live terminal (state)**: check the `supersedes` / `refines` chains and state of the retrieved nodes, and **build the frame from the live terminal**.
   **Do not use a Decision whose state is superseded as a reference point** (trace the successor via the reverse lookup of `refines`. Retrieval also de-scores terminal states
   superseded/closed/abandoned/achieved before returning, but does not exclude them — selecting the terminal is your own job here).

The "frame" obtained from these 5 steps is the skeleton of the explanation doc and the baseline for concept-delta judgment.

⚠ Reverse lookup travels **edges**, so it reaches only knowledge already **bound** to the changed Files or their crosscut parents.
What governs the change but is not wired to it — a RejectedOption about the same approach, an unbound pitfall, a Goal — is invisible here **by construction**.
Catching those is §2.3's job; do not let a rich-looking §2 frame talk you out of running the sweep.

### Concept word ↔ schema mapping (from human concept words to graph elements)

| concept word | graph carrier |
|---|---|
| layer (レイヤー) | Layer |
| component (コンポーネント) | Component |
| feature group (機能グループ) | Concern |
| issue (課題) | Risk that `risks_in` that area / Constraint under tension / unmet Goal |
| trap (罠) | Risk + OperationalKnowledge |
| policy (方針) | Decision + Constraint (`sets_policy_for` / `constrains`) |
| past history (過去経緯) | RejectedOption + `supersedes` chain + Investigation `led_to` |
| direction (向かう先) | Goal (planned/active) + active Investigation |

---

## 2.3 Semantic sweep (approach axis — reaching knowledge the File anchor cannot)

Reverse lookup finds what is **wired to the location**. But several knowledge types guard **approaches**, not locations, and are structurally invisible to §2:

- **RejectedOption**: its natural edges (`rejected_in` → Investigation, ← `supersedes` from Decision) do not touch Files. Reintroduction is an **approach match, not a location match** — the same rejected mechanism can come back in a different file, where no reverse lookup will ever meet it.
- **OperationalKnowledge**: pitfalls and workarounds are often procedural and weakly bound (or carry binding debt).
- **Constraint**: `constrains` often targets a Decision — ≥2 hops from any File, beyond what neighbor expansion reliably returns (truncation at ~10 edges/node, ~40 total).
- **Goal / active Investigation**: Goal has no File edges at all; Investigations rarely have them. Scope creep and open-question collision cannot surface from a File anchor.

So after §2, sweep **from the content of the change itself**:

1. **Distill two digests from the diff you have read** (1–2 lines each, following the parent skill graphrag-knowledge's query formula `<NL topic> + <1–2 code identifiers>`):
   - **mechanism digest** — what mechanism / approach the change introduces or alters (e.g. "retry with exponential backoff in the sync client, hand-rolled queue in `syncQueue`").
   - **intent digest** — what the change is trying to achieve (e.g. "make background sync survive flaky networks"). When a commit range is given, fold in the author's **stated** intent
     (`git log --format='%s%n%b' <base>..<head>`, and the PR description if available). A divergence between stated intent and observed mechanism is itself review material
     (scope creep / "does more than it says") — carry it into §3 rather than silently reconciling the two.
2. **Guard sweep** (what must not be tripped):
   `evidence --request "<mechanism digest>" --types RejectedOption,OperationalKnowledge,Constraint,Risk --limit 8 --neighbors 1`
   Decision is deliberately absent from the list: it is the best-bound type (§2's main catch) and would crowd the ranked slots the sweep reserves for the types reverse lookup structurally misses.
3. **Direction sweep** (where this should be heading):
   `evidence --request "<intent digest>" --types Goal,Investigation --limit 5 --neighbors 1`
   State matters here: an `abandoned` Goal hit is not noise — it is the roadmap counter-run signal (§3 Goal). For Investigation, only `active` ones raise the open-question flag; closed ones are history (their `led_to` Decisions are §2's territory).
4. **Adoption**: drop matches whose `match_confidence` is low/none (at most one reworded retry per sweep — the same cutoff discipline as `ask`). Merge survivors into the §2 frame (dedupe by id). The merged set is the input of §2.5 and §3.
5. **Two sweeps is the budget** (plus at most the one rewording each). Do not degenerate into repeat-firing.

The sweep matches on embedding + lexical similarity, **independent of binding — that is the point.** A node the sweep finds that §2's reverse lookup missed is itself evidence of a **binding gap** (§4 diagnosis 1): the knowledge exists but is not wired to the implementation it governs. Record the pair (node, changed File) — it becomes the binding proposal in the write-back (§5).

---

## 2.5 Forward expansion = impact-zone expansion (detecting "Files that should be affected but are absent from the diff")

Reverse lookup (§2) is a one-way trip "changed File → frame." The graph's true purpose is **chain expansion / coverage of the impact range**, so here we turn around and perform
**frame → File set → cross-check against the diff**. Without this, you can only see "whether the change crosses the frame," and
**"whether the change missed siblings it should have touched within the frame" (incompleteness of the change)** slips through.

1. **Impact-zone expansion**: reuse the §1.5 anchor result of each changed File (`--types File --limit 1 --neighbors 2` — already fired once; do not re-fire).
   **neighbors 2 is what makes this work** (depth1 = the owning Concern/Component/Layer and policy edges addressed directly to the File; depth2 = sibling Files. 1 does not reach the siblings).
   The seed is pinned by `--types File --limit 1` and verified by the path check of §1.5-2 (a fuzzy match would let the neighborhood of unrelated nodes contaminate the impact zone).
   Neighbor expansion returns all touching edges in **both directions**, so coverage is machine-guaranteed (dedupe edges duplicated across depths before counting).
   A File whose anchor failed §1.5 is already a declared blind spot — its impact zone is unknowable; write that into the coverage accounting (6) instead of guessing.
   What to read:
   - The `evidenced_by` File set of the owning **Concern / Component / Layer** (depth2) = sibling Files in the same Concern / Component / Layer.
   - Other destinations of the `sets_policy_for` / `constrains` / `risks_in` of the governing **Decision / Constraint / Risk**.
     If the destination is a crosscut structure (possible for `sets_policy_for` / `risks_in` only — `constrains` never targets a crosscut structure; its destinations are Decision / File / OperationalKnowledge), expand one more step via `evidenced_by` (chain expansion).
     A `constrains` → Decision destination propagates instead through that Decision's own `sets_policy_for` set (already at depth-2 of the anchor).
   - Governance surfaced by the §2.3 sweep participates too: its `sets_policy_for` / `constrains` / `risks_in` destinations are already in the sweep's own graph_context (`--neighbors 1`) — fold them into the same cross-check, no extra calls needed.
2. **Cross-check**: expanded File set − changed File set = **candidate Files that are within the impact zone but absent from the diff**.
3. **Corroborate the candidates (mandatory — do not conclude inside the graph)**: for each candidate File, whether you turn it into a finding or drop it, pass this first:
   - **Retrieve the governance that governs the candidate**: `evidence --request "<path of candidate>" --types File --limit 1 --neighbors 1`.
     This per-candidate lookup is **unconditionally mandatory as the sole path to reach low-altitude bind (Constraint / policy edges addressed directly to the File)**.
     It is a procedure that survives even if the destinations of `constrains` are expanded to crosscut structures in the future (**deleting this procedure is forbidden**).
   - **Actually read the candidate File and the relevant location in the diff**. The graph is a chain index for "where to look," not judgment material.
     Settling for "impact presence to be confirmed" without reading is forbidden (the grep ban of §0-5 is about "retrieving concepts / history from the vault."
     Reading the code under review is an obligation).
   - **Always raise both of the two questions** (phrase them in a form independent of the change shape. Do not get pulled by the words "same treatment" —
     pick up not just the lateral spread of a fix, but also following a rename / format change and conforming to a change of the norm itself, with the same questions):
     - **Left-behind**: after this change, is the candidate **still consistent with the norm / the changed side**
       (has it been left behind when it needed the same treatment / following / conformance to the now-updated norm).
     - **Premise-breaking**: even if the candidate needs no change, **does this change break the premise of the norm / constraint that governs the candidate**
       (e.g. introducing a call path that bypasses the validation layer, or letting error handling pass through).
     Only once you can confirm "it is consistent" for both can you drop the candidate ("no same treatment needed" alone is not enough to drop it).
4. **Select with paths attached**: do not mechanically enumerate all candidates (noise turns review into a ritual). After passing corroboration (3),
   attach to each candidate you turn into a finding the **propagation path** (changed File → co-owning node → candidate File) and the evidence you read.
   Example: a change touching the norm of the error-handling Concern touched only 1 of the 3 Files belonging to the Concern → read the remaining 2 Files,
   confirm the missing retry, and present with the path attached.
5. **The strength is advisory by default, but escalate and make noise if serious** (§3's table and escalation rules): the set difference itself is mechanical, but
   "whether the impact is real" is a semantic judgment, so by default do not stop. But **the tier is not a ceiling**. If corroboration shows
   "the unchanged side breaks a norm / a premise is broken"
   (e.g. the norm change of the error-handling Concern is in only one of the paths / breaking a Constraint's premise loosens security),
   that is a **Constraint / norm violation** in the shape of missed siblings, so **escalate to ACK-required** and make noise with a red band at the top.
   Further, missed siblings that you can state with high confidence are "a defect (it breaks / a hole opens)" even without a norm node, do not silence —
   surface it in the red band **explicitly marked "out-of-graph finding"** (make noise without hiding that it is an exception to the traceable principle).
6. **Accounting**: the coverage-check section of the output (an independent section) must, per frame node, record one line each for
   "number of Files expanded / number of candidates corroborated / candidates dropped and their reason."
   **"None applicable" can only be written with accounting attached** (structurally blocking writing "none" with zero expansion work).

### Subagent parallel delegation of corroboration (an additional means of execution, not a reduction of obligation)

When there are many candidates, you may delegate the reading of corroboration (3) to subagents in parallel. But:

- **Always include in the delegation payload**: ① the **full text** of the relevant diff hunk, ② the summary of the norm node that governs the candidate,
  ③ the **verbatim text** of the two questions (left-behind / premise-breaking). Do not pass summaries (a degraded summary directly degrades the corroboration).
- **Do not delegate the judgment**: restrict the subagent's response format to "quotation of the relevant location in the candidate code + observed facts + supporting node id."
  The consistent/inconsistent judgment and integration into findings happen in the main context.
- **Mandatory statement to the subagent**: no writes via `add-*` / `commit-mutation`, no direct grep of `vault/*.md`
  (inherit SKILL.md's Anti-patterns).
- Delegation is **an additional means of execution** of corroboration, not a reduction of the corroboration obligation. Even when delegated, **the all-candidate two-question (left-behind/premise-breaking) and
  the accounting obligation (6) are invariant**.

⚠ This detection power is proportional to how well the `evidenced_by` / policy edges of the crosscut nodes are wired. When no candidate comes out at all,
do not conclude "the impact zone is empty" — first suspect the possibility of a binding gap (§4).

---

## 3. Per-type interrogation (the core of pr-review / the annotation source for review-doc)

The frame (§2 ∪ §2.3 ∪ §2.5) is not a backdrop. **Every node in it gets interrogated with its type's questions below, against the diff hunks you actually read**
(graph summaries alone are not judgment material — the same reading obligation as §2.5-3). A node may be dropped as irrelevant only with a one-line reason in the accounting (§4).
Checking the crosscut boundary and stopping is the failure mode this section exists to prevent: **the boundary checks are one entry in this list, not the list.**
When the frame is large, the subagent delegation clause of §2.5 applies to this interrogation too — same payload discipline (full hunk text + the node's summary + the type's question verbatim),
same rule that the judgment and finding-integration stay in the main context. If a frame edge leaves the vault (`vault:` ref, surfaced inline as `cross_vault_resolved`),
read the inline-resolved title/summary first and follow the pointer (`ask "<question>" --vault <path>`) only when that is not enough.

Questions per type (default tier in brackets; the escalation rules below apply on top):

- **Constraint — the invariant** [violation = ACK-required]:
  State the invariant concretely, then actively search the diff for a hunk that breaks it **or weakens its enforcement** (validation removed, check made bypassable, error path silenced — all count).
  A Constraint is an immutable external condition — code cannot renegotiate it. Also check the reverse: does the change erode a premise the Constraint's enforcement rests on?
- **RejectedOption — the guard against round trips** [reintroduction = ACK-required]:
  Compare **approaches, not locations**: does any hunk re-implement the rejected mechanism (matching name / gist)? On a hit, quote the original rejection reason and its `rejected_in` Investigation,
  and demand **"why is it different this time"** — a deliberate re-try must answer the old failure mode, not ignore it.
- **Decision — the live policy** [implicit breach = advisory; escalate on real harm]:
  Does the change preserve the decision's **intent**, not just its letter? Typical silent breaches: a new code path that bypasses the decided mechanism, partial adoption that leaves the old way alive, a flipped default.
  Interrogate only the **live leaf** (§2-5); a superseded Decision is history, not policy — but a hunk that resurrects a superseded policy is a finding (lineage says it was retired deliberately).
- **OperationalKnowledge — the recorded burn** [re-stepping = advisory; escalate if the pitfall is destructive]:
  Two directions, both mandatory: (a) **re-stepping** — does the diff step into the documented pitfall, or undo the documented workaround (delete it, bypass it, "clean it up")?
  (b) **conformance** — when the OK records the sanctioned way of doing exactly what the diff is doing, does the diff follow it?
- **Risk — the open threat** [exposure increase = advisory; escalate on real harm]:
  Does the change enlarge the risk's surface in its `risks_in` area? And reverse-lookup `reduces_risk` into the Risk: if the diff weakens or removes a mitigating Decision/OK,
  the suppression is lifted and the Risk **reopens** — surface the released Risk itself as the finding, not just the edit that released it.
- **Goal — the direction** [scope creep / counter-run = advisory]:
  Which live Goal (planned/active) does this change serve? None → scope creep (a detour, or work nobody asked the system to head toward).
  Toward an `abandoned` Goal, or against an active one → roadmap counter-run. Goals rarely surface from the File anchor (no File edges; at best depth-2 via a Decision's `has_premise`) — the §2.3 direction sweep is their main entrance, so an empty Goal row in the accounting with no sweep run is a §4 violation, not "no goals".
- **Investigation (active) — the open question** [collision = advisory]:
  The diff touches the subject of an open inquiry: surface it — the author may be blind to in-flight findings, and the change may invalidate the investigation's premise mid-flight.
  Conversely, if the diff **settles** the question, say so and propose closing it in the write-back (§5).
- **Layer / Concern / Component — the crosscut frame**:
  - **Layer violation** [ACK-required]: do the imports after the change run backward against the vertical position of dependency (a lower layer depending on an upper one)?
  - **Concern bleed-out / norm vs actual** [advisory]: against the crosscut node's summary (= norm / design intent), has the post-change actual (evidenced_by) drifted?
    Example: the norm of the error-handling Concern is "surface to the user + retry," but the new path only logs → it has left the Concern.
  - **Component responsibility drift** [advisory]: the change quietly re-scopes what the Component is for (its summary no longer tells the truth about it). Sibling coverage itself is §2.5's job, not this one.
- **Cross-type propagation** (run once over the whole frame, not per node):
  - **has_premise reverse lookup (propagation of a broken premise)** [advisory; escalate on real harm]: reverse-lookup and enumerate the **live nodes** that `has_premise` on a Decision that the change breaches/supersedes.
    The has_premise inflow edges into the old node stay alive as lineage preservation — precisely because of that, unless you explicitly enumerate the "nodes that survive with a broken premise," the propagation stays invisible.
- **carving.json exemption addition** [ACK-required — human adjudication]: if the diff includes a change to `.graphrag/carving.json`, escalate the exemption addition into findings
  (carving.json is a human-owned concept layer on par with Layer/Concern/Component. The LLM may only propose; appending happens after user approval).
- **Concept delta outside the protocol / out-of-graph finding** [red band, explicitly marked]: a concept-level drift that fits no entry above, or a high-confidence pure defect with no norm node —
  do not suppress it; surface it explicitly marked **"out-of-graph finding"** (state its provenance; the exception to the traceable principle is made noisy, not hidden).

### 3-tier strength (classification of findings)

| tier | what qualifies | behavior |
|---|---|---|
| **ERROR** | breakage of the graph's internal integrity (type-pair violation etc.). The `carving-check` / `validateGraph` domain | (rare in review) reject as structure |
| **ACK-required** | machine can detect the divergence with high precision but the fix direction is human-adjudicated: **rejected-option reintroduction / layer violation / Constraint violation / carving.json exemption**. + findings escalated by severity (below) | does not reject but **stops and prompts approval** (red banner) |
| **advisory** | LLM-judgment cases: implicit breach of a Decision / OK re-stepping / Risk-exposure increase / scope creep / open-Investigation collision / Concern bleed-out / Component drift / **impact-zone missed siblings (§2.5 coverage check)** | display only (mention in context; the coverage check is an independent section) |

**The tier is the default per detection path, not a ceiling (escalation allowed / de-escalation not allowed)**: even an advisory-band finding, if it crosses with a governing
Constraint / Concern norm / Risk and you can judge "real harm results (it breaks / a hole opens / a premise is broken / a suppressed Risk reopens)," should be
**escalated to ACK-required** and made noise with a red band. A pure defect finding with no norm node must also not be suppressed — surface it in the red band with "out-of-graph finding"
stated explicitly (do not hide the exception to the traceable principle). The no-hard-reject principle (§0-2) does not change after escalation —
making noise goes only as far as "stop and confirm"; the fix-direction ruling stays with the human.

**Semantic regressions at sub-File granularity (the error-visibility example) default to the advisory band — even when the governing node is a Constraint.** A catch block that quietly stops surfacing errors is an LLM judgment, not a machine stop: a *suspected* regression is advisory; the ACK row's "Constraint violation" is for the *confirmed* case. By laying the governing policy out next to the hunk, the suspicion is reliably put in front of the human (and the reviewing LLM) — and once you can state with confidence that the invariant is actually broken, the escalation rule above takes it to the red band.

---

## 4. Knowledge-utilization accounting and gap diagnosis (important)

The review ends with an accounting that makes under-use of the graph visible, and a diagnosis for every hole. This generalizes the old "frame self-check": not just "did *anything* surface" but "did **each type** get its chance, and what does an empty row mean."

**Accounting (an independent section of the output)** — one line per knowledge type
(Decision / Constraint / RejectedOption / OperationalKnowledge / Risk / Goal / Investigation / crosscut Layer·Concern·Component):
`pulled N (§2: a / §2.3: b) / interrogated M / findings K / dropped with one-line reasons`.
**"Nothing applicable" may be written only with this accounting attached** — the same structural block as §2.5-6: zero retrieval work must never be writable as "none".

**Diagnosis of a 0-pulled type** — "pulled 0" is a fact about retrieval, not about the vault. Distinguish three causes and state which one you suspect:

1. **Binding gap** — the knowledge exists but is not wired to the implementation it governs (= `carving-check` #9 knowledge-impl-binding-missing).
   Signature: **the §2.3 sweep hits a node that §2's reverse lookup missed** (the sweep is binding-independent, so the discrepancy localizes the missing edge).
   Prescription: state in the finding "this area has no governing policy bound on the graph (suspected binding gap). Retrieve candidates via `edge-suggest-policy` (`--missing-only --changed-files <changed paths>` narrows it to this diff) and bind the policy so it is picked up next time," and carry the (node, changed File) pair into the write-back (§5).
   Do not silently conclude "no policy." A silent binding gap is exactly the essence of why a policy regression slipped through in the past (see the regression case in the vault record: `ask "エラー可視化の退行"`).
2. **Retrieval gap** — the digest's vocabulary missed it. The one reworded retry (§2.3-4) is the only permitted retry; past that, state the residual blind spot honestly instead of re-firing.
3. **Genuine absence** — the vault has never recorded this type for this area. That is itself reviewable information: if the area plainly deserves a guard of that type
   (e.g. an auth-touching diff with zero recorded Constraints), say so in the findings. And if the review itself surfaced a judgment / constraint / burn worth keeping,
   propose capturing it in the write-back (§5) — the review is not only a consumer of the graph; it is where the graph learns what it was missing.

---

## 5. Output manner

- **Always attach the supporting node id to a finding** (traceable principle). Example: `⚠ [advisory] suspected regression of the error-visibility policy (constraint:...:errors-surface-to-user)`.
- **Vary the prominence by tier**: ACK-required goes gathered at the top and made prominent; advisory is attached at the relevant location.
- **Emit the knowledge-utilization accounting (§4) as its own section** (pr-review / review-doc; design-review's per-type accounting is the same obligation in its own output shape), alongside the §2.5 coverage-check section.
- **Date the reference point when it matters**: a supporting node written long before heavy churn in its area is a weaker reference — say so in the finding ("last verified before this area churned"; `staleness-check` machine-lists such candidates, read-only) instead of presenting old policy as fresh. This keeps §0-2 honest: whether the graph went stale or the code went wrong is exactly the call that belongs to the human.
- **A non-assertive ruling**: leave the fix-direction choice to the human — "possibly crossing the frame. Whether to fix the code, or to update the policy (graph) side and approve the intent change, is for the human to decide."
- **Write-back of the resolution (preventing review alarm fatigue)**: when a human resolves a finding — ACK-required or advisory — by "approving the intent change,"
  propose the approved intent change as a mutation — an update to the Decision (state update etc.), the policy-reversal recipe
  (create a new Decision, wire it to the old via `refines`, update the old to state superseded. If the option discarded by the reversal could re-tempt, also attach a
  RejectedOption), or a new RejectedOption — and connect it to the write-back of the graphrag-knowledge skill. The same channel also carries the review's other harvest:
  **binding proposals for §4-diagnosed gaps** (from `edge-suggest-policy` candidates or the §2.3 sweep-vs-§2 discrepancy pairs), **closing an active Investigation the diff settled** (§3 Investigation),
  and **new knowledge the review surfaced in a genuinely-absent area** (§4 diagnosis 3).
  **If you do not update the graph, the same finding recurs at the next review and the ACK becomes a ritual (review alarm fatigue)**.
  Do not end at approval; only once you make the graph side follow the post-approval reality can it be called resolved.
