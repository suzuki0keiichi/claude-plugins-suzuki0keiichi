# Drift Reconciliation — presentation format details

Only when **both contexts are present — the LLM has read the relevant node via retrieval AND has read the code in the same area during the current task** — and you notice "the graph description conflicts with the current source," do not rewrite it on your own LLM judgment.

Reason: drift detection carries a higher misjudgment risk than addition (Proactive Persistence) because the LLM has not done a full investigation. A wrong update / delete loses the original information.

A systematic divergence audit (the go-look-for-it kind) is a separate thing. Only when the user explicitly asks. Do not run a full drift sweep in the middle of the current task.

## Presentation format (structured)

```
Drift detected: <node-id> (<type>: "<summary excerpt>")
Observed in code: <facts, 1-3 lines>
Options:
  [u] update: rewrite summary to <proposal> (reason: ...)
  [d] delete: the feature/concept is gone, so delete the whole node
  [s] skip: the graph is correct (different layer / intentional difference), leave as is
  [i] investigate: don't decide here, split off a separate investigation task
```

- `Observed in code` is facts only (do not mix in inference). Attach the file paths you observed.
- Do not narrow the options to a single proposal; list them with reasons, foregrounding the one the LLM considers most likely. The final call is the user's.

## Applying after the user's ruling

If the user picks `[u]` / `[d]`, write back to the vault via `commit-mutation` (an op:update / op:delete plan) (typed-update is not provided; reconsider if it recurs). Plan templates: the Update / Delete sections of `${CLAUDE_PLUGIN_ROOT}/references/mutation-templates.md`.

- `[s]` writes nothing (just state the skip reason in conversation; do not create a skip-record node in the graph).
- `[i]` is split off as an investigation task. If the investigation continues across sessions, stand up an Investigation via `add-investigation` (default state is "active").
