---
name: graphrag-design-review
version: 1.2.1
description: 設計案や approach を、コードを書く前にグラフ（プロジェクトの永続知識）と照合してレビューする AI 設計レビュー。「実装前にこの方針でいい?」「この設計どう思う」「この approach を見て」と、実装に入る前の設計・計画の是非や、過去判断・制約との整合・roadmap との親和性を確認したい時に使う。実装後の diff レビューは graphrag-pr-review、人間向けの説明資料は graphrag-review-doc。スラッシュ: /graphrag-knowledge:graphrag-design-review
---

# Design Review (pre-implementation, knowledge axis)

High-altitude review at plan/design time. approach soundness, roadmap affinity, proportionality,
and domain boundaries are cruel to "redo" at diff time, so review them here, before implementation.

For the shared foundation, CLI invocation, and invariants (never hard-reject / traceable / no grep, etc.),
**you must first read `${CLAUDE_PLUGIN_ROOT}/references/graph-review-method.md`**. This skill documents only
the procedure specific to its "knowledge axis (pre-implementation face)".

## Input

The design proposal / approach / plan under review. If `$ARGUMENTS` carries a description, use it; otherwise target the design proposal from the recent conversation context.

## Procedure

1. **Draw the frame for the area (knowledge axis)**: pull the area the proposal touches with a single `ask`.
   ```sh
   node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts ask "<proposal area> の Decision / Constraint / Goal / Risk / 却下案" --limit 8
   ```
   - Include in the query both the proposal's domain words (natural language) and concrete code identifiers the proposal touches (file / component / function names) — method §1 query discipline. A single-register query narrows the hit surface.
   - Do not fire repeatedly. If needed, deep-dive a specific node's neighborhood with `evidence --request "<node title or path>"` just once or twice (evidence cannot be looked up by id — method §1; confirm the target via direct_evidence's id/type, then read graph_context).
2. **Perspectives to check against** (high-altitude perspectives that matter before implementation):
   - **Implicit breach of an existing Decision**: is the proposal silently breaking the intent of a settled decision in that area, without saying so?
   - **Rejected-option reintroduction**: is the proposal the same approach as a past RejectedOption (= a past guard; if reconsidering, demand "why is it different this time")?
   - **Constraint violation**: is it breaking a constraint that must be upheld?
   - **has_premise reverse lookup (premise-breaking propagation)**: reverse-look-up the
     **live nodes** that `has_premise` onto a Decision the proposal breaches/supersedes, and check whether any
     survive with a broken premise (has_premise onto old nodes lives on for lineage preservation, so the
     propagation is invisible unless you enumerate them).
   - **roadmap affinity**: relative to where we are headed (Goals whose status is planned/active), is it a detour/regression, or in a withdrawal direction (abandoned)?
   - **proportionality (magnitude)**: is the change excessive/insufficient relative to the target system's posture (lifespan/importance/maturity)? posture acts as a global gain that recalibrates the weight of every perspective.
   - **scope creep**: is the proposal untied to any Goal?
3. **When no frame can be drawn**: if no knowledge node governing the area surfaces, per method §4
   state in the findings the "suspected frame not bound to the area" (point to `edge-suggest-policy`). Do not silently call it "no policy".

## Output

- Per perspective, advice **with the supporting node id attached**. Not an assertion but the form "possible frame crossing; whether to change the code or update the policy side to approve the intent change is for the human to decide".
- **Accounting**: per perspective, record the "number of nodes pulled". **"Nothing applicable" may be written only with accounting attached**
  (structurally blocking writing "none" with zero pulling work).
- Surface severe divergences (rejected-option reintroduction, Constraint violation) prominently at the top as **ACK-required**; attach the rest as advisory.
- Finally, offer a one-line suggestion of "if this design is adopted, what should be left in the vault as Decision/RejectedOption" (connecting to the graphrag-knowledge skill's write-back).
