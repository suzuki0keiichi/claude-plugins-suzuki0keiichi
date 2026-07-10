---
name: graphrag-review-doc
version: 1.5.1
description: 人間が PR レビューするための、概念レベルの説明資料(視覚的な HTML 文書)をグラフ（プロジェクトの永続知識）を背骨に生成する。「この PR のレビュー資料を作って」「概念レベルで説明する文書がほしい」「レビュアー向けに分かりやすく説明して」と、人間レビュアーに渡す資料を求められた時に使う。AI が所見を返すレビュー本体は graphrag-pr-review（本 skill は成果物が HTML 文書である時に選ぶ）。スラッシュ: /graphrag-knowledge:graphrag-review-doc
---

# Human-facing PR Review Doc (explanation-first / HTML)

Produce a concept-level explanation doc to hand to human reviewers. **Review with only file diffs + a summary becomes a ritual**, so
build a "concept-altitude map" with the graph as backbone. The first deliverable is not a violation list but an **explanation** (explanation-first, method §0).

For the shared foundation, the reverse-lookup skeleton, and the instruction-text↔schema mapping,
**you must first read `${CLAUDE_PLUGIN_ROOT}/references/graph-review-method.md`**. The reverse-lookup procedure is shared with pr-review.

## Input

If `$ARGUMENTS` carries a base/head, use it; otherwise target the current working diff.

## Procedure (execute method §1.5 → §2 → §2.5 → §3 verbatim)

0. **Freshness precheck** — execute method §1.5 verbatim. For Files absent from the graph, state "stale index" as a blind spot at **the top of the doc** (do not hide it).
1. **Build the frame by reverse lookup** — execute method §2 verbatim (same pipeline as pr-review; pull with `ask` / `evidence`, do not grep).
2. **Match against the impact zone by forward expansion** — execute method §2.5 verbatim. Candidates **require corroboration — actually read the candidate Files and the diff** (do not conclude from within the graph alone). Note them alongside in the doc's "what was touched", with propagation path + a judgment made after reading.
3. **Pick up concept deltas** — execute method §3 verbatim. **The doc emits these not as a separate list but as annotations within the relevant section**.
4. **Assemble the HTML doc**. Visually clear. Cover the graph-derived information and make the explanation hit the core. Write the document text in the conversation language (the audience is the human reviewers, not the LLM).

## Doc structure (graph as backbone)

Productized from the user's real-world review instruction (the ConversationChunk that is the source of vault: `ask "グラフを使った PR レビュー層"`):

- **Overview**: what this PR changes conceptually (1–2 paragraphs).
- **Affected structures** (crosscut axis): enumerate the **Layer / Component / Concern** touched,
  what each is, and how this PR changes it. Quote each node's summary (= norm / design intent).
- **Each structure's issues / policy / traps / history** (knowledge axis, woven into the section):
  - Issues = Risks that `risks_in` that area / Constraints in tension / unmet Goals
  - Policy = the governing Decision / Constraint (framed as **does the change satisfy this?**; e.g. "this area is governed by 'errors are shown to the user'. Does this change satisfy it?")
  - Traps = Risk / OperationalKnowledge
  - Past history = RejectedOption / supersedes chain
- **Concept-delta annotations**: embed the divergences picked up in step 3 as prominent callouts within the relevant section
  (ACK-required = red banner "needs checking", advisory = supplementary yellow callout).
- **What was touched**: show the changed Files tied to the structures above (Layer/Component/Concern).
  **Files that belong to the same structure but were not touched** (missed-sibling candidates from step 2) are noted alongside with their propagation path
  (e.g. "2 of the 3 Files in this Concern are touched. I read the remaining one — still on the old error handling with no retry support, inconsistent with the post-change norm. Follow-up is likely needed").
  Writing only "impact needs checking" without reading is forbidden (method §2.5-3 corroboration). For nothing applicable, state "none" explicitly with accounting (number expanded / number corroborated).
  Missed siblings judged to break a norm/constraint (real harm results) are treated as a red banner "needs checking" (method §3 escalation rule).

## Invariants (method §0)

- **traceable**: every policy/history claim in the doc must trace to a human-approved knowledge node. Attach a supporting node id (or vault link) to each statement. Do not let AI free-composition get an approval stamp.
- **Frame self-check** (method §4): if there is an area where no governing policy can be pulled, honestly state in the doc "this area has no policy binding in the graph (suspected binding gap; a spot where review accuracy drops)". Do not hide it.
- This is an advisory document, not a verdict. Write it so that the fix-direction ruling (fix the code or update the policy) is left to the human reviewer.

## Output location

Write the HTML to a single file (default name: `review-doc-<branch>.html` in the working directory; a name not to be confused with pr-review's findings output). Tell the user the output path.
