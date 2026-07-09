# Shared method for graph-backed review

The foundation shared by the 3 skills `/graphrag-knowledge:graphrag-design-review` / `:graphrag-pr-review` / `:graphrag-review-doc`.
The three look different but share one root: **"take a change (or proposal) as the starting point, reverse-lookup the graph, and check it at the concept altitude against the human's frame."**
The only differences are input axis and output shape:

| skill | input axis | timing | output |
|---|---|---|---|
| graphrag-design-review | design proposal / approach (knowledge axis = pre-implementation face) | plan / design time | advice (concept-altitude findings) |
| graphrag-pr-review | change diff (crosscut axis + File = post-implementation face) | PR / diff time | findings (classified in 3 tiers) |
| graphrag-review-doc | change diff (same as above) | before PR review | human-facing explanation doc (HTML) |

> ※ The section numbers of this reference (§0–§5, including sub-numbers §1.5 / §2.5) are referenced from the SKILL.md of the 3 skills above. When you add / remove / reorder a section, update the referrers (each skill's "method §N" notation) accordingly.

pr-review and review-doc share **almost the same pipeline** (reverse lookup → forward-expansion coverage → concept delta). The difference is whether the output is findings or a doc.
Only design-review reads on an axis leaning toward the knowledge axis (Goal/Decision/Constraint/Risk).

---

## 0. Premises (invariants common to these 3 commands)

These follow the design recorded in the vault (retrievable via `ask "グラフを使った PR レビュー層の目的"`):

1. **The goal is controllability, not QA.** AI beats humans at bug detection at the diff level, so hunting for bugs is not the main aim here. The aim is "delegate the broad strokes, but don't cross the frame" — checking that the code has not broken the intent of the concept layer the human owns (knowledge axis + crosscut axis Layer/Concern/Component).
2. **Never hard reject.** A machine cannot decide whether a graph-vs-code divergence means the graph is stale or the code is wrong. So **visualize rather than reject**. The responsibility for fixing (the fix-direction ruling) belongs to the human.
3. **explanation-first.** The first job is not a "violation list" but a "concept-altitude explanation." Violations are surfaced as concept-delta annotations inside the explanation doc.
4. **traceable.** Every finding / claim must trace back to a human-approved knowledge node (with source backing). Do not let AI free-writing be stamped with authorization. Always attach the id of the supporting node to a finding.
5. **Never grep.** "What concepts / history / traps / policies exist" is retrieved via `ask` / `evidence`. Do not read `vault/*.md` or `graphrag/*.ts` directly (conforming to SKILL.md's Anti-patterns).
   This is about the **knowledge-retrieval path**, whereas **reading the code under review (the diff, candidate Files) is in fact an obligation** (§2.5-3).
   Concluding findings from inside the graph alone produces a superficial review, so it is forbidden.

---

## 1. How to invoke the CLI (common to all commands)

```sh
node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts <verb> [args]
```

In a dev environment where the repo was cloned directly, `${CLAUDE_PLUGIN_ROOT}` does not exist, so from the repo root invoke it relatively as
`node --experimental-strip-types graphrag/cli.ts <verb>`.

Verbs used:
- `ask "<question>"` — retrieve concepts / history / traps / policies in one shot (auto-escalation brief→evidence). **Do not repeat-fire.**
  Query wording follows the parent skill's §Query discipline: **mix natural-language terms and code-language identifiers in one query** (knowledge is distilled in natural language while code uses English identifiers — using only one register narrows the hit surface). When the question alone is unlikely to hit, add `--gist "<expected one-liner answer>"`.
- `evidence --request "<title/path>" [--types T] [--limit N] [--neighbors N]` — trace the neighborhood (governance / derivation) of a specific node.
  **Cannot be looked up by id** (id is excluded from the search target). Confirm the target node via direct_evidence's id / type, then read graph_context.
  Do not adopt results whose `match_confidence` is low/none.
- `carving-check --graph <path> [--vector-index <path>]` — structural gate. In particular, watch **#9 knowledge-impl-binding-missing** (a policy not bound to an implementation).
- `edge-suggest-policy` — machine-extract `sets_policy_for` candidates from Decision/Constraint/Risk → File (for binding completion).

---

## 1.5 Freshness precheck (before starting reverse lookup)

Reverse lookup (§2) implicitly assumes that "the changed Files are on the graph." If the index lags the diff,
every subsequent step silently misses. So **before starting reverse lookup**, confirm that each File in the diff exists on the graph:

1. Look up each changed File via `evidence --request "<path of changed File>" --types File --limit 1` (same invocation as the impact-zone expansion in §2.5-1, so it is not double work).
2. **If there is a File not present on the graph**: surface at the **head of the findings** — "the graph does not know this diff (the index is stale). Either run an incremental index / carve first, or explicitly note this File set as a review blind spot at the top." Do not silently skip.

The cause differs from the binding gap in §4: §4 is "the File is on the graph but no governing policy is bound" (binding gap →
the prescription is bind completion via `edge-suggest-policy`); here it is "the File itself is not on the graph" (index lag → the prescription is incremental index/carve).
Conflating them routes the wrong prescription.

---

## 2. Skeleton of reverse lookup (shared procedure for pr-review / review-doc)

Taking the changed File set as input, assemble the "frame" from the graph:

1. **Take the changed Files**: `git diff --name-only <base>...<head>` (or the current working diff).
2. **Reverse-lookup the landing point** (crosscut axis): retrieve which **Layer (レイヤー) / Component (コンポーネント) / Concern (脈)** each changed File belongs to, via `ask` / `evidence`.
   - Routing signals like "a change entered the UI Layer" surface here (changed File → interface/screen Layer or UI Component).
3. **Reverse-lookup governance** (knowledge axis): retrieve the **Decision / Constraint / Risk / OperationalKnowledge that governs** that File / Component / Layer / Concern
   (reverse direction of `sets_policy_for` / `constrains` / `risks_in` / `documented_by`).
   = "What policies / constraints / risks is this area bound by."
4. **Past history**: retrieve related **RejectedOptions** and `supersedes` chains, and `Investigation -led_to-> Decision`.
   = "What has already been rejected here, and how each judgment came to be."
5. **Confirm the live terminal (state)**: check the `supersedes` / `refines` chains and state of the retrieved nodes, and **build the frame from the live terminal**.
   **Do not use a Decision whose state is superseded as a reference point** (trace the successor via the reverse lookup of `refines`. Retrieval also de-scores terminal states
   superseded/closed/abandoned/achieved before returning, but does not exclude them — selecting the terminal is your own job here).

The "frame" obtained from these 5 steps is the skeleton of the explanation doc and the baseline for concept-delta judgment.

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

---

## 2.5 Forward expansion = impact-zone expansion (detecting "Files that should be affected but are absent from the diff")

Reverse lookup (§2) is a one-way trip "changed File → frame." The graph's true purpose is **chain expansion / coverage of the impact range**, so here we turn around and perform
**frame → File set → cross-check against the diff**. Without this, you can only see "whether the change crosses the frame," and
**"whether the change missed siblings it should have touched within the frame" (incompleteness of the change)** slips through.

1. **Impact-zone expansion**: with the changed File as seed, retrieve via `evidence --request "<path of changed File>" --types File --limit 1 --neighbors 2`.
   **neighbors must be 2** (depth1 = the owning Concern/Component/Layer and policy edges addressed directly to the File; depth2 = sibling Files. 1 does not reach the siblings).
   Pin the seed to the changed File with `--types File --limit 1` (a fuzzy match lets the neighborhood of unrelated nodes contaminate the impact zone).
   Neighbor expansion returns all touching edges in **both directions**, so coverage is machine-guaranteed (dedupe edges duplicated across depths before counting).
   If `match_confidence` is low/none, do not adopt graph_context as the impact zone (one alternate keyword → if still no good, treat as the binding gap of §4).
   What to read:
   - The `evidenced_by` File set of the owning **Concern / Component / Layer** (depth2) = sibling Files in the same Concern / Component / Layer.
   - Other destinations of the `sets_policy_for` / `constrains` / `risks_in` of the governing **Decision / Constraint / Risk**.
     If the destination is a crosscut structure (`sets_policy_for` / `risks_in` only. **The destination of `constrains` is File-only**), expand one more step via `evidenced_by` (chain expansion).
2. **Cross-check**: expanded File set − changed File set = **candidate Files that are within the impact zone but absent from the diff**.
3. **Corroborate the candidates (mandatory — do not conclude inside the graph)**: for each candidate File, whether you turn it into a finding or drop it, pass this first:
   - **Retrieve the governance that governs the candidate**: `evidence --request "<path of candidate>" --types File --limit 1 --neighbors 1`.
     This per-candidate lookup is **unconditionally mandatory as the sole path to reach low-altitude bind (Constraint / policy edges addressed directly to the File)**.
     It is a procedure that survives even if the destination of `constrains` is expanded in the future (**deleting this procedure is forbidden**).
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

## 3. Concept-delta judgment (the core of pr-review / the annotation source for review-doc)

Against the "frame" obtained from reverse lookup, check whether the change crosses the frame. Perspectives:

- **Rejected-option reintroduction**: does the change revive the same approach as a past RejectedOption (matching name / gist).
- **Layer violation (Layer)**: do the imports after the change run backward against the vertical position of dependency (a lower layer depending on an upper one).
- **Implicit breach of a Decision**: does it break, without stating so, the intent of a Decision that governs the area.
- **Concern bleed-out / norm vs actual**: against a crosscut node's summary (= norm / design intent), has the post-change actual (evidenced_by) drifted.
  Example: the norm of the error-handling Concern is "surface to the user + retry," but the new path only logs → it has left the Concern.
- **Governance violation**: does the change satisfy the area's Constraint / established policy.
  Example: in an area with policies "errors surface to the user (N-failures UI)" and "there is a retry mechanism," an addition that only does catch+log → policy regression.
- **scope creep**: a change not tied to any Goal (is it a detour / running counter to where it is headed).
- **has_premise reverse lookup (propagation of a broken premise)**: reverse-lookup and enumerate the **live nodes** that `has_premise` on a Decision that the change breaches/supersedes.
  The has_premise inflow edges into the old node stay alive as lineage preservation — precisely because of that, unless you explicitly enumerate the "nodes that survive with a broken premise,"
  the propagation stays invisible.
- **reduces_risk release**: a Risk that a Decision the change weakens/breaches had been `reduces_risk`-ing **reopens**.
  Surface the Risk whose suppression has been removed as a finding.
- **OperationalKnowledge re-stepping**: does the change nullify a known pitfall / workaround (OperationalKnowledge),
  or reintroduce a hole stepped into in the past.
- **carving.json exemption addition**: if the diff includes a change to `.graphrag/carving.json`, **escalate the exemption addition into findings for
  human adjudication** (carving.json is a human-owned concept layer on par with Layer/Concern/Component. The LLM may only propose; appending happens after user approval).
- **Concept delta outside the perspective list**: if you notice a concept-level drift that fits none of the above, do not suppress it —
  surface it explicitly with the same manner as an "out-of-graph finding" (state its provenance; see the escalation rules below).

### 3-tier strength (classification of findings)

| tier | what qualifies | behavior |
|---|---|---|
| **ERROR** | breakage of the graph's internal integrity (type-pair violation etc.). The `carving-check` / `validateGraph` domain | (rare in review) reject as structure |
| **ACK-required** | machine can detect the divergence with high precision but the fix direction is human-adjudicated: **rejected-option reintroduction / layer violation / Constraint violation**. + findings escalated by severity (below) | does not reject but **stops and prompts approval** (red banner) |
| **advisory** | LLM-judgment cases: Concern bleed-out / implicit breach of a Decision / governance regression / scope creep / **impact-zone missed siblings (§2.5 coverage check)** | display only (mention in context; the coverage check is an independent section) |

**The tier is the default per detection path, not a ceiling (escalation allowed / de-escalation not allowed)**: even an advisory-band finding, if it crosses with a governing
Constraint / Concern norm / Risk and you can judge "real harm results (it breaks / a hole opens / a premise is broken)," should be
**escalated to ACK-required** and made noise with a red band. A pure defect finding with no norm node must also not be suppressed — surface it in the red band with "out-of-graph finding"
stated explicitly (do not hide the exception to the traceable principle). The no-hard-reject principle (§0-2) does not change after escalation —
making noise goes only as far as "stop and confirm"; the fix-direction ruling stays with the human.

**This kind of policy regression (the error-visibility example) is the advisory band**. It is a semantic judgment, and at the sub-File granularity of a catch block, so it does not become a machine stop. But by laying out the policy in the explanation doc, it is reliably put in front of the human (and the reviewing LLM).

---

## 4. Self-check of whether the premise is satisfied (important)

If reverse lookup (steps 2-3) surfaced **not a single knowledge node governing the area**, that likely means not "there is no frame" but
**"the frame is not bound to the area"** (= `carving-check` #9 knowledge-impl-binding-missing).
Even if the policy exists in the vault, if it is not connected to the implementation File via `sets_policy_for` / `constrains`, it does not surface in reverse lookup = it slips through review.

- On detecting this state, state in the finding: **"this area has no governing policy on the graph (suspected binding gap). Retrieve candidates via `edge-suggest-policy` and bind the policy so it is picked up next time."**
- Do not silently conclude "no policy." A silent binding gap is exactly the essence of why a policy regression slipped through in the past (see the regression case in the vault record: `ask "エラー可視化の退行"`).

---

## 5. Output manner

- **Always attach the supporting node id to a finding** (traceable principle). Example: `⚠ [advisory] suspected regression of the error-visibility policy (constraint:...:errors-surface-to-user)`.
- **Vary the prominence by tier**: ACK-required goes gathered at the top and made prominent; advisory is attached at the relevant location.
- **A non-assertive ruling**: leave the fix-direction choice to the human — "possibly crossing the frame. Whether to fix the code, or to update the policy (graph) side and approve the intent change, is for the human to decide."
- **Write-back of the resolution (preventing review alarm fatigue)**: when a human resolves an ACK-required finding by "approving the intent change,"
  propose the approved intent change as a mutation — an update to the Decision (state update etc.), the policy-reversal recipe
  (create a new Decision, wire it to the old via `refines`, update the old to state superseded. If the option discarded by the reversal could re-tempt, also attach a
  RejectedOption), or a new RejectedOption — and connect it to the write-back of the graphrag-knowledge skill.
  **If you do not update the graph, the same finding recurs at the next review and the ACK becomes a ritual (review alarm fatigue)**.
  Do not end at approval; only once you make the graph side follow the post-approval reality can it be called resolved.
