---
name: graphrag-review-doc
version: 1.6.0
description: 人間が PR レビューするための、概念レベルの説明資料(視覚的な HTML 文書)をグラフ（プロジェクトの永続知識）を背骨に生成する。「この PR のレビュー資料を作って」「概念レベルで説明する文書がほしい」「レビュアー向けに分かりやすく説明して」と、人間レビュアーに渡す資料を求められた時に使う。AI が所見を返すレビュー本体は graphrag-pr-review（本 skill は成果物が HTML 文書である時に選ぶ）、実装前の設計レビューは graphrag-design-review。スラッシュ: /graphrag-knowledge:graphrag-review-doc
---

# Human-facing PR Review Doc (explanation-first / HTML)

Produce a concept-level explanation doc to hand to human reviewers. **Review with only file diffs + a summary becomes a ritual**, so
build a "concept-altitude map" with the graph as backbone. The first deliverable is not a violation list but an **explanation** (explanation-first, method §0).

For the shared foundation, the reverse-lookup skeleton, the semantic sweep, and the instruction-text↔schema mapping,
**you must first read `${CLAUDE_PLUGIN_ROOT}/references/graph-review-method.md`**. The retrieval pipeline is shared with pr-review.

## Input

If `$ARGUMENTS` carries a base/head, use it; otherwise target the current working diff.

## Procedure (execute method §1.5 → §2 → §2.3 → §2.5 → §3 verbatim)

0. **Freshness precheck** — execute method §1.5 verbatim. For Files absent from the graph, state "stale index" as a blind spot at **the top of the doc** (do not hide it).
1. **Build the frame by reverse lookup** — execute method §2 verbatim (same pipeline as pr-review; pull with `ask` / `evidence`, do not grep).
2. **Semantic sweep** — execute method §2.3 verbatim (mechanism digest → guard sweep; intent digest → direction sweep). This is what fills the doc's
   "traps / history / direction" content for knowledge not edge-bound to the touched Files — without it the doc can only show what was already wired.
3. **Match against the impact zone by forward expansion** — execute method §2.5 verbatim. Candidates **require corroboration — actually read the candidate Files and the diff** (do not conclude from within the graph alone). Note them alongside in the doc's "what was touched", with propagation path + a judgment made after reading.
4. **Pick up concept deltas** — execute the per-type interrogation of method §3 verbatim. **The doc emits these not as a separate list but as annotations within the relevant section**.
5. **Assemble the HTML doc**. Visually clear. Cover the graph-derived information and make the explanation hit the core. Write the document text in the conversation language (the audience is the human reviewers, not the LLM).

## Doc structure (graph as backbone)

Productized from the user's real-world review instruction (the ConversationChunk that is the source of vault: `ask "グラフを使った PR レビュー層"`):

- **Overview**: what this PR changes conceptually (1–2 paragraphs).
- **Affected structures** (crosscut axis): enumerate the **Layer / Component / Concern** touched,
  what each is, and how this PR changes it. Quote each node's summary (= norm / design intent).
- **Each structure's issues / policy / traps / history / direction** (knowledge axis, woven into the section):
  - Issues = Risks that `risks_in` that area / Constraints in tension / unmet Goals
  - Policy = the governing Decision / Constraint (framed as **does the change satisfy this?**; e.g. "this area is governed by 'errors are shown to the user'. Does this change satisfy it?")
  - Traps = Risk / OperationalKnowledge (including sweep-found burns about the same mechanism from elsewhere — quote the pitfall next to the hunk that risks re-stepping it)
  - Past history = RejectedOption / supersedes chain (a sweep-found RejectedOption matching the PR's approach is prime doc material: quote the original rejection reason)
  - Direction = which live Goal this serves / which active Investigation it touches or settles (from the §2.3 direction sweep)
- **Concept-delta annotations**: embed the divergences picked up in step 4 as prominent callouts within the relevant section
  (ACK-required = red banner "needs checking", advisory = supplementary yellow callout).
- **What was touched**: show the changed Files tied to the structures above (Layer/Component/Concern).
  **Files that belong to the same structure but were not touched** (missed-sibling candidates from step 3) are noted alongside with their propagation path
  (e.g. "2 of the 3 Files in this Concern are touched. I read the remaining one — still on the old error handling with no retry support, inconsistent with the post-change norm. Follow-up is likely needed").
  Writing only "impact needs checking" without reading is forbidden (method §2.5-3 corroboration). For nothing applicable, state "none" explicitly with accounting (number expanded / number corroborated).
  Missed siblings judged to break a norm/constraint (real harm results) are treated as a red banner "needs checking" (method §3 escalation rule).
- **Graph coverage footer**: a compact rendition of the knowledge-utilization accounting (method §4) — per knowledge type, what was consulted and what came up empty,
  with binding/retrieval gaps stated honestly (human reviewers deserve to know where the map has blank spots).

## Invariants (method §0)

- **traceable**: every policy/history claim in the doc must trace to a human-approved knowledge node. Attach a supporting node id (or vault link) to each statement. Do not let AI free-composition get an approval stamp.
- **Gap honesty** (method §4): if a knowledge type or an area comes up empty, state it in the doc — "this area has no policy binding in the graph (suspected binding gap; a spot where review accuracy drops)" — instead of hiding it. Do not silently turn a binding gap into "no policy".
- This is an advisory document, not a verdict. Write it so that the fix-direction ruling (fix the code or update the policy) is left to the human reviewer.

## Output location

Write the HTML to a single file (default name: `review-doc-<branch>.html` in the working directory). Tell the user the output path.
