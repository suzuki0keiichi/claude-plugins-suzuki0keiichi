# File interpretation guidance (universal; retrieval distinctiveness first)

General principles that apply to any codebase. Not tied to a specific repo or a specific query. Read each file's actual contents and write a natural-language **Japanese summary** such that semantic search correctly ranks that file first. This is the only semantic text that enters the embedding. Distinctiveness is everything.

**The summary text itself is written in natural Japanese** (the vault content language) — the instructions here are in English, but what you write into the `summary` is Japanese prose. **The general Japanese search terms a user would actually type must appear in the summary.**

## Structure (always in this order)

1. At the very front, one angle-bracket **type tag**. Choose the one that fits the file's essence:
   〈ロジック〉〈APIルート〉〈UI〉〈管理UI〉〈データアクセス〉〈定数定義〉
   〈設定〉〈ユーティリティ〉〈型定義〉〈テスト〉〈ドキュメント〉〈スクリプト〉 etc.
2. Immediately after, **one sentence on this file's distinguishing function**. Lead with "what is different" from sibling files of the same kind / same domain. Do not start with, or close on, the shared category word.
3. If needed, 1–2 sentences of behavior.

## General rules

- **Put the distinguishing axis up front**: assume multiple files of the same kind may exist, and lead with the core that belongs to this one file alone (what it handles, its means, its inputs/outputs, its boundary). Do not start or close with a generic summarizing word. The reader must be able to tell it apart from siblings by the summary alone.
- **Foreground the user's search terms**: put the general Japanese words a developer/user would search for toward the front. Even if the code calls the feature by an internal codename, metaphor, or product-specific pet name, **write the general feature name first** and relegate the internal label to a supplement. Never use only the internal name.
- **Always include the file's own core concept (omission prohibited)**: the file's central concept — what the file-name/path stem and the main export names denote — must appear in the summary body in general terms. Do not replace it with, or drop it in favor of, an internal metaphor, persona name, or codename. The file must be able to rank first for the feature its name denotes.
- **Cover every word of the path concept**: if the file name/directory is a compound concept, surface **all of its constituent words** in general Japanese in the summary. Format of the example: if the path is `<A>-<B>` or `<A>/<B>` and A and B are separate concepts, include both the A word and the B word (do not include only one). Even if the internal label names only one of them, do not omit the concept the path indicates — supply it in Japanese. Users search by the path's concept words, so a missing one won't surface in search.
- **Write entry points as "a receiving surface that delegates"**: thin layers such as routes/handlers/CLI entry points/facades should not be written as if they themselves implement the business verb (validate, compute, generate, etc.). Write it like "〈APIルート〉… receiving surface. The body delegates to the callee logic," making explicit that the implementation lives on the logic side. This makes "where is the processing/logic" queries hit the body, not the thin entry point.
- **Aggregate types: enumeration is strictly forbidden (adhere)**: files that touch many areas thinly — constants, config, index/barrel, **broad documents/specs/requirements**, etc. — must not enumerate any of the areas/items inside. State the role in one phrase (~12 words max) and stop. Format of the example: 「〈定数定義〉アプリ全体の各種設定値を一元管理」「〈ドキュメント〉実装範囲を規定する要件文書」. Enumerating weakly matches every query and crowds out the implementation body. Violations not allowed.
- **Cleanly separate UI from non-UI logic**: for operation-screen / display entry points, mark 〈UI〉/〈管理UI〉 explicitly and write "operation/display entry point." For the body that judges, computes, generates, or persists, mark 〈ロジック〉〈データアクセス〉 etc. explicitly. Even under the same feature name, "processing body" vs. "operation UI" must be distinguishable from the summary alone.
- Length is 1–3 sentences, at most ~220 chars. Do not put a verbose preamble (long background/setup sentences) at the front. Distinguishing function first, incidental detail short and at the back.
- Do not pad with speculated functionality. Stay faithful to the actual contents. Judge on general principles only; do not speculate on or reference external evaluations, tests, or expected answers.

## Output

For each input path, one `{"path","summary"}` entry, using the same path string as the input.
