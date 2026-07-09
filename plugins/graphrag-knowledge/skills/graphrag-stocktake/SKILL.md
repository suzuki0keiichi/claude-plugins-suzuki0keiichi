---
name: graphrag-stocktake
version: 1.1.0
description: vault の Investigation ライフサイクル棚卸し(定期クリーニング)。state無しレガシーや、決着済みなのに active のままの focus を、機械検出(stocktake verb)+ 裏取り裁定で state:closed に整える。「棚卸しして」「vault を掃除/クリーニングして」「Investigation を整理して」「active が溜まってる」で発火。resume の stocktake_hint が出た時にも。削除はしない(閉じるだけ)。スラッシュ: /graphrag-knowledge:graphrag-stocktake
---

# Investigation stocktake (lifecycle periodic cleaning)

A periodic sweep that tidies the state of Investigations accumulated in the vault, via machine detection + corroborated adjudication. For the read/write foundation and CLI details, follow the parent skill `graphrag-knowledge` and `$REF/` (= `${CLAUDE_PLUGIN_ROOT}/references`). `$CLI` = `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts`.

## Scope (what this skill does and does not do)

- The **primary channel for cleanup is the always-on triggers** (pre-commit nudge, checkpoint, the closed judgment at write-back when implementation reaches a milestone). This skill is the **later-stage periodic sweep that picks up their leftovers/misses**, not a replacement for the always-on triggers.
- Detection is delegated to the deterministic verb (`stocktake`); this skill handles **adjudication only**. Do not make the LLM read the whole vault (per §Anti-patterns in the parent skill).
- Fire on an explicit instruction like "stocktake", or when you see the `stocktake_hint` returned by `brief --mode resume`.

## Procedure

1. Run `$CLI stocktake [--days <N=14>] [--vault <dir>]` to get the suspect list (read-only, deterministic). signals: `stateless` | `stale-active` | `no-generated-at` | `progress-claim`. If suspects are zero, report "healthy" and stop.
2. **Adjudicate each suspect with corroboration.** Adjudication rules (the core of this skill):
   - **Corroboration against code, tests, git evidence, and chat evidence beats the summary's self-report** (unimplemented / in-progress / incomplete). If tests or an implementation actually exist / it shipped, the investigation is settled = closed even if the summary says "unimplemented".
   - **Remaining code work is owned by the Decision/Risk side** — an Investigation closes on "the investigation / focus being settled". Even if the code is unfinished, if the investigation itself (what was tried and what was learned) is done, closed is fine.
   - **A genuinely ongoing focus stays active** (if a stateless suspect is really still a moving focus, explicitly assign `state:"active"` — do not leave a dangling item found during stocktake unattended).
   - **If you cannot corroborate and are unsure, do not close it — report it** (do not close on your own). A state change with no basis leads to irreversible information loss.
3. Bundle the settled ones into **a single commit-mutation** (a plan that changes only `state` via `op:update`) and apply in one batch. For just a single item, a minimal plan on the spot suffices.
4. Report (per §Reporting format in the parent skill): in natural language, briefly — the count closed and a summary of the grounds / the focuses left active / the deferrals and their reasons. Do not dump IDs / raw JSON.

## Off-limits (never do)

- **Do NOT delete.** Lineage preservation is the way — closed is discounted 0.6× in ranking, so it naturally sinks in search results (it is not excluded).
- **Do NOT step into whether knowledge nodes (Decision/Risk/OK, etc.) are "still true"** — that is the domain of drift-reconciliation (`$REF/drift-reconciliation.md`). This skill handles only the state of Investigations.
