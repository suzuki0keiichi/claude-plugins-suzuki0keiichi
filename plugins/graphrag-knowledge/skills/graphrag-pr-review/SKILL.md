---
name: graphrag-pr-review
version: 1.6.1
description: PR や diff を、AI 自身がグラフ（プロジェクトの永続知識）と照合して概念レベルでレビューし、所見(findings)を返す。境界 (Layer/Concern/Component) の確認だけでなく、Constraint 違反・却下案 (RejectedOption) の再導入・運用知識 (OperationalKnowledge) の再踏襲・Risk の再開・Goal との整合・進行中 Investigation との衝突まで、全知見タイプに diff を尋問する。「この PR をレビューして」「この差分をグラフ的に見て」「概念が崩れてない?」「方針に反してない?」と、実装後の変更の是非を問われた時に使う（行レベルのバグ探しが主目的ではない）。人間に渡す説明資料(HTML)が欲しい時は graphrag-review-doc、実装前の設計レビューは graphrag-design-review、変更の記録は graphrag-knowledge。スラッシュ: /graphrag-knowledge:graphrag-pr-review
---

# PR Review (post-implementation, crosscut + knowledge axes / performed by AI)

Review at diff time. **The goal is controllability, not QA** (AI is already strong at line-level bug detection; here
we check three things: "whether the change crosses the frame of the human-owned concept layer," "whether it trips any recorded knowledge —
constraints, rejected options, operational burns, open risks, goals, open questions," and "whether it missed sibling files it should have touched within the frame").
Boundary checking alone wastes the vault — every knowledge type gets its interrogation (method §0-6).

For the shared foundation, CLI invocation, the reverse-lookup skeleton, the semantic sweep, the per-type interrogation protocol, and the enforcement level of the 3 tiers,
**you must first read `${CLAUDE_PLUGIN_ROOT}/references/graph-review-method.md`**. This skill is only a summary of the execution procedure.

## Input

If `$ARGUMENTS` carries a base/head (e.g. `main...HEAD`), use it; otherwise target the current working diff.

## Procedure (execute method §1.5 → §2 → §2.3 → §2.5 → §3 → §4 verbatim)

0. **Anchor pass (freshness precheck)** — execute method §1.5 verbatim: one `evidence --types File --limit 1 --neighbors 2` per changed File, **results kept for reuse** (§2 reads the frame off them, §2.5 the impact zone — no re-firing). For Files absent from the graph, surface "stale index" at **the top of the findings** (its cause and prescription differ from the binding gap in §4).
1. **Get the changed Files and read the diff** — method §2-1: the file list (`git diff --name-only <base>...<head>`) *and* the diff content itself (the current working diff if no range is given). The digests, the interrogation and the corroboration all judge hunks, not file names.
2. **Build the frame by reverse lookup** — execute method §2 verbatim: read landing point / governance / history off the anchor results; the only new retrieval is one area-level `ask` (plus at most one or two single-node deep-dives). **Build the frame at live leaves** (do not anchor on a state-superseded Decision).
3. **Semantic sweep** — execute method §2.3 verbatim: read the diff, distill the **mechanism digest** and the **intent digest**, then fire the guard sweep
   (`--types RejectedOption,OperationalKnowledge,Constraint,Risk`) and the direction sweep (`--types Goal,Investigation`) once each.
   **Do not skip this because the §2 frame already looks rich** — RejectedOption / unbound OperationalKnowledge / Goal / active Investigation are structurally invisible to reverse lookup,
   and a sweep hit that reverse lookup missed is the binding-gap signature (§4 diagnosis 1).
4. **Match against the impact zone by forward expansion** — execute method §2.5 verbatim (the impact zone comes from the anchor results' depth-2 — no re-firing). Candidates **must be corroborated — actually read the candidate Files and the relevant spots in the diff** (settling for "needs checking" without reading is forbidden). If corroboration shows a norm/constraint is broken, **escalate to ACK-required** and raise the alarm. When candidates are many, you may delegate in parallel to subagents per the delegation clause of method §2.5 (delegation adds a means of execution; it does not shrink the obligation).
5. **Interrogate every frame node with the per-type protocol** — execute method §3 verbatim: each node from §2 ∪ §2.3 ∪ §2.5 gets its type's questions put to the diff hunks you read
   (Constraint = invariant broken or enforcement weakened / RejectedOption = approach reintroduced, "why is it different this time" / Decision = intent silently breached /
   OperationalKnowledge = burn re-stepped or sanctioned way ignored / Risk = exposure grown or mitigation removed → Risk reopens / Goal = scope creep, roadmap counter-run /
   active Investigation = open-question collision or settlement / Layer·Concern·Component = boundary checks / has_premise reverse = broken-premise propagation).
   If the diff includes a change to `.graphrag/carving.json`, **escalate the exemption addition into findings for human adjudication**. Concept deltas outside the list are surfaced per the "out-of-graph finding" convention (do not silently ignore).
6. **Classify into 3 tiers** — the table and escalation rules of method §3. **A tier is not a ceiling** — findings judged to cause real harm (breaks, opens a hole, premise-breaking, reopens a suppressed Risk) escalate to ACK-required. A pure defect with no norm node is also surfaced in the red band, explicitly marked as an "out-of-graph finding".
7. **Knowledge-utilization accounting + gap diagnosis** — execute method §4 verbatim: one accounting line per knowledge type (pulled §2/§2.3 / interrogated / findings / drops with reasons);
   every 0-pulled type gets the three-way diagnosis (binding gap / retrieval gap / genuine absence). Do not silently turn a binding gap into "no policy"; suspect a binding gap even when forward expansion yields zero candidates.

## Output

- **Collect ACK-required at the top** (red light; prompts "stop and check"; never rejects).
- **Emit the coverage check as its own section** (impact zone − diff, method §2.5): candidates carry propagation path + supporting node id + **a judgment made after reading**.
  Per frame node, record the **accounting** of "number of Files expanded / number of candidates corroborated / dropped candidates and why" —
  "nothing applicable" may be written only with accounting attached. The default is the advisory band; missed siblings that break a norm/constraint also go into the ACK band at the top.
- **Emit the knowledge-utilization accounting as its own section** (method §4): one line per type, with the three-way diagnosis stated for every empty row. This is what proves the review used the whole vault, not just the boundaries.
- **Attach advisory to the relevant spot**. Attach **a supporting node id to every finding without exception** (traceable).
- Cast each finding in the form "possible frame crossing; whether to fix the code or update the policy (graph) side to approve the intent change is for the human to decide", leaving the fix-direction ruling to the human.
- **Resolution write-back** (method §5): once a human resolves a finding (ACK-required or advisory) by "approving the intent change", propose the approved intent change as a mutation
  (Decision update / policy-reversal recipe / new RejectedOption) and connect it to the graphrag-knowledge skill's write-back. The same channel carries the review's other harvest:
  binding proposals for §4-diagnosed gaps, closing an active Investigation the diff settled, and new knowledge surfaced in a genuinely-absent area.
  Without updating the graph, the same finding recurs next time (alarm fatigue in review).
- State that line-level bug hunting is not the main target (route to a separate AI code review if needed) and concentrate on the concept layer.
  That said, **do not silently ignore a high-confidence defect you happen to find** — surface it in the red band, explicitly marked as an "out-of-graph finding".
