---
name: graphrag-checkpoint
version: 1.5.0
description: context が埋まって消える前に、いま価値あるものを全部グラフへ吐き出す「最終フラッシュ」。長時間セッションで compact の盲目的要約に任せず狙って残し、`/clear` で綺麗に再開できるようにする。「checkpoint 取って」「コンテキスト埋まってきたから状態を保存」「clear する前に退避して」「compact される前に退避して」で発火。人間が余力のある頃合いで手動発火する (自動検出はしない)。退避後に `/clear` すると SessionStart フックが直前の作業状態を自動で戻す (このskillは退避側)。スラッシュ: /graphrag-knowledge:graphrag-checkpoint
---

# Compact Checkpoint (flush / final flush)

Fire manually when context is filling up (just before compact, or before a deliberate `/clear`), flushing to the graph with **A (flush of work-state) and B (rescue of un-written-back durable knowledge) as equal partners**. A clean restart is **checkpoint → `/clear`** (§C). For the read/write foundation and CLI details, follow the parent skill `graphrag-knowledge` and `$REF/` (= `${CLAUDE_PLUGIN_ROOT}/references`). `$CLI` = `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts`.

## Scope (what this skill does and does not do)

- This **runs proactive-persistence on a "pre-compact" trigger**. Existing always-on triggers (pre-commit nudge, etc.) stay in place. checkpoint is the later stage that **sweeps up their leftovers/misses**.
- **The primary channel is always-on triggers.** checkpoint can only capture what still remains in context at fire time — you cannot preserve everything from a 100%-full context. The value is **deliberately keeping what matters** (better than compact's blind summarization).
- **Firing is manual, human-only.** No signal for remaining context exists, and the "right moment" cannot be auto-detected. A human fires it while there is still headroom. Firing itself consumes context, so **fire before things get tight**.
- **checkpoint's essence is saving ctx.** Since each flush/rescue step itself consumes context, keep reading within this skill to a minimum (the lightweight duplicate-check rule for B is in §B).
- **Restore is out of scope for this skill.** The SessionStart hook (`clear-restore.mjs`) reads the intent that Procedure C wrote into the reserved `__checkpoint__` key of the vault-side `.graphrag/cache/ask-state.json` (resolved by the same rule as the writer, including `.env` `GRAPHRAG_VAULT_DIR` redirects) **only right after `/clear`**, and **consumes it (one-shot, single use)** the moment it reads, then restores. 60-min expiry, cwd match. **Nothing is injected after compact** (left to blind summarization — the old auto-injection is fully abolished). **checkpoint → `/clear` → clean restart** is the cleanest, with zero blind summarization, and is the sole auto-restore path. If tightness lets auto-compact swallow you, there is no fallback — next session, manually fire `$CLI brief --mode resume` to trace from the same Investigation.
- **Handover ack contract.** The hook's injection is invisible to the human, so it obligates the restored agent to **open its first reply by declaring the restore** (restored focus + first action), and likewise to declare when a checkpoint existed but was not restored (expired / different directory). Therefore: **a first reply after `/clear` that opens with no declaration means the handover failed** — recover with `$CLI brief --mode resume`. This detection rule is told to the user at checkpoint time (§Reporting).

## Procedure

### 0. preset judgment
Run `$CLI inspect` to check the vault type → read only the matching system / project quickref (§Schema quick-ref in the parent skill). The rescue-destination vocabulary differs.

### A. Flush (work-state → active Investigation + ConversationChunk)

1. Run `$CLI brief --mode resume` to find **the active Investigation for the current focus**.
   - If present, **update** (while the focus is the same, keep updating the one). Procedure C **passes this Investigation's id to `checkpoint-mark` by name**, so keep exactly 1 active per focus (restore is by id name — it does not depend on generated_at or primary selection).
   - If absent, **create** (`state: active`). If the focus changed midway, set the old one to `state: closed` and create a new one (§Focus continuity in the parent skill).
   - **If the checkpoint is the session's "close" and the focus itself is settled**, set this Investigation to `state: closed` and do NOT fire Procedure C (checkpoint-mark) — settled work needs no restore.
2. Write the **work-state as structured text into that Investigation's `raw_content`** (via commit-mutation `updates`; note: do not create a dedicated field):
   - `current focus:` what you are doing now (a one-liner restart point after restore)
   - `next:` the concrete next action (granular enough to resume without re-deriving; drop finished branches). **The first item is the "unique first action"** — always place at the head one action concretized down to its target (file:line or command to run) and expected result, so the agent right after restore can start without hesitation. Writing that can only start with exploration, like "investigate ~" or "clean up around ~", is forbidden (that is the main cause of post-restore wandering and ctx waste).
   - `blocker:` sticking points, unresolved dependencies, waits
   - `touched:` files being edited / targeted (file:line and "what you are trying to change" where possible)
3. Deep raw logs (failed paths / exact commands / non-obvious findings / constraints the user stated this session / mid-flight state of multi-step changes) go into a **ConversationChunk**, **update-in-place with a fixed slug** (avoid bloat; high-value fragments only). Wire it to the Investigation via `discussed_in`. **Sanitize on write** (parent skill §Content hygiene): no verbatim abusive language / insults / personal information, even when "quoting the user" — flush the substance (constraint, decision, cause), not the phrasing.
4. **Pre-flush self-check** (ask yourself before writing work_state):
   - Reading only the head of next, can you enter the first edit/command without exploration?
   - Are there contradictions or stale statements among current focus / next / touched (did you drop finished branches)?
   - If either is No, rewrite before flushing. A vague checkpoint comes back as the cost of "not being able to uniquely narrow what to do, and searching around" after restore.

### B. Rescue (un-written-back durable knowledge → existing knowledge types, auto-written)

Make one pass **by type** over un-written-back durable knowledge to close gaps. The recall trigger is chiefly the model's memory (git diff is optional support — commit timing and work breaks are offset, so do not make it mandatory).

- **Decision** (a judgment chosen from alternatives)
- **RejectedOption** (an approach tried and discarded — **leaves the least trace; pick it up first**)
- **Risk** (a future threat you noticed)
- **OperationalKnowledge** (operational gotchas / workarounds)
- project preset only: **Assumption** (a premise you set) / **Agreement** (an agreement)

For each candidate:
1. **Keep duplicate-check lightweight.** Knowledge this session itself produced (an option just tried and discarded, a gotcha just hit) is unlikely to collide with existing nodes, so **you may skip the upfront ask** — if the write-time duplicate gate returns a suspect, handle it with skip / update / `--dup-ack`. (This is a checkpoint-only relaxation of the parent skill's "ask pre-check" principle. Rationale: checkpoint's essence is saving ctx, and hammering per-type asks bloats easily via evidence escalation.) Only for candidates that might be updates to existing knowledge (general points likely to predate the session) run `$CLI ask "<candidate>" --limit 2`.
2. **Auto-write only what is missing** via `add-*` / `commit-mutation` (do not wait for approval; write clear ones immediately, surface only truly borderline ones in the report). Link touched files via `documented_by` in evidence.
3. **Wire knowledge this focus produced to the Investigation** (so restore reaches real nodes, not just prose):
   - Attach **`derived_from`** (knowledge node → Investigation) on all B nodes (universal provenance; both presets).
   - For Decision, additionally **`led_to`** (Investigation → Decision).

**Off-limits**: do NOT write to planning/schedule types (**Task / Milestone / Resource / Stakeholder**). project's Task is the project's own plan, not a sink for the products of this chat work.

### C. Marker (declaring /clear-restore intent; the mandatory close)

Once writing is done, fire **`$CLI checkpoint-mark --investigation <id>`** (`<id>` is the id of the active Investigation you updated/created in Procedure A). This is the **one-shot intent declaration** to the SessionStart hook: "if `/clear` happens, restore me":

- The verb validates before firing and, if it fails, **hard-errors and makes you fix it on the spot**: the target node is an **active Investigation** / `raw_content` has both `current focus:` and `next:` / a **unique first action** can be extracted from the head of `next` / `raw_content` is **within 8KB** (if over, split deep raw logs out into a ConversationChunk). §A's self-check is guidance at write time; this validation is the **last line of defense**.
- If it passes, it stamps the `work_state` snapshot and `first_action` into the reserved key **`__checkpoint__`** of `.graphrag/cache/ask-state.json` (no new file is created).
- The SessionStart hook (`clear-restore.mjs`) reads this key **only right after `/clear`**, and **consumes it (one-shot, single use)** the moment it reads, then restores. 60-min expiry, cwd match. It does not rely on wall-clock alone, so it will not miss even if you read the report or chat before `/clear`. The injected text obligates the restored agent to open its first reply with a restore declaration (§Scope, Handover ack contract) — success is always verbalized, so silence is a reliable failure signal.
- **Nothing is injected after compact** (the old behavior is fully abolished). If auto-compact swallows you under tightness, next session, manually fire `$CLI brief --mode resume` to trace from the same Investigation.
- **Forget to fire it and no `/clear` restore happens at all** (the old generated_at 10-min gate is already abolished — the problem of missing on a re-checkpoint with unchanged content is itself gone). Do not skip C.

## Reporting (user-facing)

In natural language: the flushed focus / **the first action at the head of next (in one sentence)** / the count of next actions / sticking points; and for the rescue, **what you wrote / what was skipped as existing / what was deferred as a judgment call** — briefly. Close with "Marked — OK to `/clear` (within 60 min)" **plus the detection rule in one sentence**: after `/clear`, the first reply will open by declaring the restored focus and first action — if it doesn't, the handover failed; recover with `brief --mode resume`. Do not dump IDs / raw JSON (§Reporting format in the parent skill).

## Batch-apply hint

A and B are independent node groups, but can be **bundled into a single `commit-mutation` plan** (Investigation update + ConversationChunk + new knowledge nodes + `discussed_in`/`derived_from`/`led_to` edges). Template: `$REF/mutation-templates.md`. For just a single piece of knowledge, typed-add (`add-*`) suffices. C's `checkpoint-mark --investigation <id>` is a standalone verb not part of the plan — fire it once at the end.
