---
name: graphrag-design-review
version: 1.3.1
description: 設計案や approach を、コードを書く前にグラフ（プロジェクトの永続知識）と照合してレビューする AI 設計レビュー。過去の Decision・Constraint・却下案 (RejectedOption)・運用知識 (OperationalKnowledge)・Risk・Goal・進行中 Investigation の全知見タイプに proposal を尋問する。「実装前にこの方針でいい?」「この設計どう思う」「この approach を見て」と、実装に入る前の設計・計画の是非や、過去判断・制約との整合・roadmap との親和性を確認したい時に使う。実装後の diff レビューは graphrag-pr-review、人間向けの説明資料は graphrag-review-doc。スラッシュ: /graphrag-knowledge:graphrag-design-review
---

# Design Review (pre-implementation, knowledge axis)

High-altitude review at plan/design time. approach soundness, roadmap affinity, proportionality,
and domain boundaries are cruel to "redo" at diff time, so review them here, before implementation.

For the shared foundation, CLI invocation, and invariants (never hard-reject / traceable / no grep, etc.),
**you must first read `${CLAUDE_PLUGIN_ROOT}/references/graph-review-method.md`**. This skill documents only
the procedure specific to its "knowledge axis (pre-implementation face)". There is no diff yet, so the
File-anchored steps (method §1.5 / §2 / §2.5) do not apply — retrieval is the area `ask` plus the semantic sweep (§2.3).

## Input

The design proposal / approach / plan under review. If `$ARGUMENTS` carries a description, use it; otherwise target the design proposal from the recent conversation context.

## Procedure

1. **Draw the frame for the area (knowledge axis)**: pull the area the proposal touches with a single `ask`.
   ```sh
   node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts ask "<proposal area> の Decision / Constraint / Goal / Risk / 却下案" --limit 8
   ```
   - Include in the query both the proposal's domain words (natural language) and concrete code identifiers the proposal touches (file / component / function names) — method §1 query discipline. A single-register query narrows the hit surface.
   - Do not fire repeatedly. If needed, deep-dive a specific node's neighborhood with `evidence --request "<node title or path>"` just once or twice (evidence cannot be looked up by id — method §1; confirm the target via direct_evidence's id/type, then read graph_context).
2. **Semantic sweep** — execute method §2.3 with **the proposal itself as the digest source** (no diff exists yet):
   distill the proposal's **mechanism digest** (what mechanism/approach it introduces) and **intent digest** (what it is trying to achieve), then fire the guard sweep
   (`--types RejectedOption,OperationalKnowledge,Constraint,Risk`) and the direction sweep (`--types Goal,Investigation`) once each.
   The area `ask` of step 1 anchors on the *area*; the sweep anchors on the *approach* — a RejectedOption or an operational burn about the same mechanism in a different area surfaces only here.
3. **Interrogate per type** — execute method §3 with "the diff" read as "the proposal": every node from step 1 ∪ step 2 gets its type's questions
   (Constraint = would the proposal break or weaken the invariant / RejectedOption = same approach as a past rejection, demand "why is it different this time" /
   Decision = silent breach of a settled intent / OperationalKnowledge = does the plan re-step a recorded burn or ignore the sanctioned way /
   Risk = does it grow exposure or plan to remove a mitigation (the suppressed Risk reopens) / Goal = scope creep, roadmap counter-run /
   active Investigation = collides with or settles an open question / has_premise reverse = which live nodes survive with a broken premise if the proposal supersedes a Decision).
   Perspectives specific to this pre-implementation face, on top of §3:
   - **proportionality (magnitude)**: is the change excessive/insufficient relative to the target system's posture (lifespan/importance/maturity)? posture acts as a global gain that recalibrates the weight of every perspective.
     Pull posture from what the vault records (VAULT.md self-introduction / top-level Goals); when the vault does not record it, state the posture you assumed in the accounting instead of silently guessing.
4. **Accounting + gap diagnosis** — method §4 in this skill's output shape: per knowledge type, record "pulled N (ask / sweep) / interrogated M / findings K".
   **"Nothing applicable" may be written only with accounting attached** (structurally blocking writing "none" with zero pulling work).
   For a 0-pulled type, state the three-way diagnosis (binding gap → point to `edge-suggest-policy` / retrieval gap / genuine absence). Do not silently call it "no policy".

## Output

- Per type, advice **with the supporting node id attached**. Not an assertion but the form "possible frame crossing; whether to change the design or update the policy side to approve the intent change is for the human to decide".
- Surface severe divergences (rejected-option reintroduction, Constraint violation) prominently at the top as **ACK-required**; attach the rest as advisory.
- Include the per-type accounting (step 4) so the review provably consulted every knowledge type, not just the ones the area query happened to return.
- Finally, offer a one-line suggestion of "if this design is adopted, what should be left in the vault as Decision/RejectedOption" — and, if the proposal settles an active Investigation surfaced in step 2, note that it can be closed (connecting to the graphrag-knowledge skill's write-back).
