---
name: graphrag-stocktake
version: 1.2.0
description: vault の定期棚卸し(ライフサイクル + 配線負債のクリーニング)。①state無しレガシーや決着済みなのに active のままの Investigation を state:closed に、②「あとで」のまま停滞した Goal (planned/active) を続行/achieved/abandoned に、③未ガード Constraint (enforcement debt) と参照腐敗マーカーの返済を、機械検出(stocktake / constraint-check / xref-check --root)+ 裏取り裁定で整える。「棚卸しして」「vault を掃除/クリーニングして」「Investigation を整理して」「active が溜まってる」「enforcement debt を返済して」で発火。resume の stocktake_hint / open_goals や ask の enforcement_debt が出た時にも。削除はしない(閉じる/宣言するだけ)。スラッシュ: /graphrag-knowledge:graphrag-stocktake
---

# Vault stocktake (lifecycle + wiring-debt periodic cleaning)

A periodic sweep that tidies the vault's lifecycle state and wiring debt, via machine detection + corroborated adjudication. For the read/write foundation and CLI details, follow the parent skill `graphrag-knowledge` and `$REF/` (= `${CLAUDE_PLUGIN_ROOT}/references`). `$CLI` = `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts`.

## Scope (what this skill does and does not do)

- The **primary channel for cleanup is the always-on triggers** (pre-commit nudge + delta-check headlines, checkpoint, the closed judgment at write-back when implementation reaches a milestone). This skill is the **later-stage periodic sweep that picks up their leftovers/misses**, not a replacement for the always-on triggers.
- Detection is delegated to the deterministic verbs (`stocktake`, `constraint-check`, `xref-check --root`); this skill handles **adjudication only**. Do not make the LLM read the whole vault (per §Anti-patterns in the parent skill).
- Fire on an explicit instruction like "stocktake", or when you see the `stocktake_hint` / `open_goals` returned by `brief --mode resume`, or the `enforcement_debt` riding on `ask`.
- Why a dedicated event exists at all: field data shows debt is **not repaid "in passing"** — enforcement_debt rode along on every `ask` for weeks and nobody repaid it, while the same kind of prompt at a dedicated moment produced action. Repayment needs its own moment; this skill is that moment.

## Procedure

1. **Lifecycle sweep**: run `$CLI stocktake [--days <N=14>] [--vault <dir>]` (read-only, deterministic). Suspects carry `type` (`Investigation` | `Goal` | `Constraint`) and signals: `stateless` | `stale-active` | `no-generated-at` | `progress-claim` | `stale-planned-goal` | `stale-active-goal` | `settled-premise` (+ `abandoned-premise`). If suspects are zero, say so and move to step 3.
2. **Adjudicate each suspect with corroboration** (the core of this skill):
   - **Investigations** — corroboration against code, tests, git evidence, and chat evidence beats the summary's self-report (unimplemented / in-progress / incomplete). If tests or an implementation actually exist / it shipped, the investigation is settled = closed even if the summary says "unimplemented". Remaining code work is owned by the Decision/Risk side — an Investigation closes on "the inquiry being settled". A genuinely ongoing focus stays active (assign `state:"active"` explicitly to stateless ones that still move). If you cannot corroborate, do not close — report it.
   - **Goals (deferred work)** — three honest outcomes, corroborate before choosing: the work happened (git/code evidence) → `achieved`; the premise died or nobody will ever do it → `abandoned` (say so — a dead promise kept "planned" is a lie that resurfaces forever); still genuinely wanted → keep, and check the wiring: if the debt has a findable home (including the extension seed file for new-capability reservations) and `documented_by` is missing, add it now; if the Goal is genuinely placeless, record that judgment instead — it rides the resume/stocktake lanes only, and that is a legitimate state, not a gap.
   - **Constraints with `settled-premise` (debt shadows)** — the "until X is done, Y cannot be trusted" warning whose premise Goals have all settled. Two different endings, split by the `abandoned-premise` signal: (a) premises **achieved** — corroborate that Y actually got fixed (the Goal claims it; verify against code/tests), then delete the shadow (301 successor if a durable invariant replaced it); if Y is somehow still broken, reopen honestly (new Goal + rewire the shadow's premise to it). (b) any premise **abandoned** — the breakage became permanent, so do NOT just delete the still-true warning: convert the shadow into a premise-less permanent Constraint (keep the constrains wiring, drop has_premise) or downgrade to a Risk, whichever is honest.
3. **Wiring-debt sweep**: run `$CLI constraint-check --root <repo>` and `$CLI xref-check --root <repo>`. For each `unguarded` Constraint, the finding's `next_step`/`plan_fragment` is the prescription: wire a real enforcer (`enforced_by` + `graphrag:enforces` marker) or declare `enforcement:"none"` with a reason — pick per constraint, do not blanket-declare. For marker findings (broken / 301 / superseded), repoint or remove per `next_step`. This is repayment work sized for a stocktake session; if the pile is large, repay the top few and report the remainder honestly.
4. Bundle the settled ones into **a single commit-mutation** (state changes via `op:update`, plus any wiring edges) and apply in one batch. For just a single item, a minimal plan on the spot suffices.
5. Report (per §Reporting format in the parent skill): in natural language, briefly — what was closed/achieved/abandoned and the grounds / what stays open and why / how much debt was repaid and how much remains. Do not dump IDs / raw JSON.

## Off-limits (never do)

- **Do NOT delete.** Lineage preservation is the way — terminal states are discounted 0.6× in ranking, so they naturally sink in search results (not excluded). `abandoned` is a state, not a deletion.
- **Do NOT step into whether knowledge nodes (Decision/Risk/OK, etc.) are "still true"** — that is the domain of drift-reconciliation (`$REF/drift-reconciliation.md`). This skill handles lifecycle state and wiring debt only.
- **Do NOT force repayment.** Enforcement debt stays advisory (the migration-rail decision): this skill is the offered moment, not a gate. Declining with a reason is a legitimate outcome — record it via `enforcement:"none"` + `enforcement_reason` so it stays visibly unenforceable instead of silently unguarded.
