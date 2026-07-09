---
name: graphrag-pr-review
version: 1.5.0
description: PR や diff を、AI 自身がグラフ（プロジェクトの永続知識）と照合して概念レベルでレビューし、所見(findings)を返す。「この PR をレビューして」「この差分をグラフ的に見て」「概念が崩れてない?」「方針に反してない?」と、実装後の変更の是非を問われた時に使う（行レベルのバグ探しが主目的ではない）。人間に渡す説明資料(HTML)が欲しい時は graphrag-review-doc、実装前の設計レビューは graphrag-design-review、変更の記録は graphrag-knowledge。スラッシュ: /graphrag-knowledge:graphrag-pr-review
---

# PR Review (post-implementation, crosscut axis + File / performed by AI)

Review at diff time. **The goal is controllability, not QA** (AI is already strong at line-level bug detection; here
we look at "whether the change crosses the frame of the human-owned concept layer" plus "whether it missed sibling files it should have touched within the frame").

For the shared foundation, CLI invocation, the reverse-lookup skeleton, concept-delta perspectives, and the enforcement level of the 3 tiers,
**you must first read `${CLAUDE_PLUGIN_ROOT}/references/graph-review-method.md`**. This skill is only a summary of the execution procedure.

## Input

If `$ARGUMENTS` carries a base/head (e.g. `main...HEAD`), use it; otherwise target the current working diff.

## Procedure (execute method §1.5 → §2 → §2.5 → §3 → §4 verbatim)

0. **Freshness precheck** — execute method §1.5 verbatim. For Files absent from the graph, surface "stale index" at **the top of the findings** (its cause and prescription differ from the binding gap in §4).
1. **Get the changed Files**: `git diff --name-only <base>...<head>` (the current working diff if no range is given).
2. **Build the frame by reverse lookup** — execute method §2 verbatim. One `ask` per area, no repeated firing. **Build the frame at live leaves** (do not anchor on a state-superseded Decision).
3. **Match against the impact zone by forward expansion** — execute method §2.5 verbatim. Candidates **must be corroborated — actually read the candidate Files and the relevant spots in the diff** (settling for "needs checking" without reading is forbidden). If corroboration shows a norm/constraint is broken, **escalate to ACK-required** and raise the alarm. When candidates are many, you may delegate in parallel to subagents per the delegation clause of method §2.5 (delegation adds a means of execution; it does not shrink the obligation).
4. **Judge concept deltas** — execute the perspective list of method §3 verbatim. If the diff includes a change to `.graphrag/carving.json`, **escalate the exemption addition into findings for human adjudication**. Concept deltas outside the perspective list are also surfaced explicitly per the "out-of-graph finding" convention (do not silently ignore).
5. **Classify into 3 tiers** — the table and escalation rules of method §3. **A tier is not a ceiling** — findings judged to cause real harm (breaks, opens a hole, premise-breaking) escalate to ACK-required. A pure defect with no norm node is also surfaced in the red band, explicitly marked as an "out-of-graph finding".
6. **Frame self-check** — execute method §4 verbatim (do not silently turn a binding gap into "no policy"; suspect a binding gap even when forward expansion yields zero candidates).

## Output

- **Collect ACK-required at the top** (red light; prompts "stop and check"; never rejects).
- **Emit the coverage check as its own section** (impact zone − diff, method §2.5): candidates carry propagation path + supporting node id + **a judgment made after reading**.
  Per frame node, record the **accounting** of "number of Files expanded / number of candidates corroborated / dropped candidates and why" —
  "nothing applicable" may be written only with accounting attached. The default is the advisory band; missed siblings that break a norm/constraint also go into the ACK band at the top.
- **Attach advisory to the relevant spot**. Attach **a supporting node id to every finding without exception** (traceable).
- Cast each finding in the form "possible frame crossing; whether to fix the code or update the policy (graph) side to approve the intent change is for the human to decide", leaving the fix-direction ruling to the human.
- **Resolution write-back** (method §5): once a human resolves an ACK-required finding by "approving the intent change", propose the approved intent change as a mutation
  (Decision update / policy-reversal recipe / new RejectedOption) and connect it to the graphrag-knowledge skill's write-back.
  Without updating the graph, the same finding recurs next time (alarm fatigue in review).
- State that line-level bug hunting is not the main target (route to a separate AI code review if needed) and concentrate on the concept layer.
  That said, **do not silently ignore a high-confidence defect you happen to find** — surface it in the red band, explicitly marked as an "out-of-graph finding".
