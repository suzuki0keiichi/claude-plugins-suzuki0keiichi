# ask 出力フィールドガイド

`ask` の出力に含まれるフィールドの詳細。行動ルール (連打抑止・打ち切り判定) は SKILL.md「Retrieval ladder and `ask` cutoff」に記載。

共通原則: null / 欠損フィールドは出力されない (`path: null` のような埋め草は無い)。無いキーは「その属性が無い」と読む。

## `final_stage`

`brief` / `evidence` — どこまで自動段上げしたか。brief の confidence が high かつ matches ありなら `brief` で停止、それ以外は evidence まで自動で掘る。`evidence` で `direct_evidence` が空なら本当に無い。

## `next_action_hint`

**最終段** の結果から計算される (brief で十分なら brief の、evidence まで掘ったなら evidence の confidence/件数を見る)。そのままユーザー向け説明として使える文言。

## `stages[*].output.query.match_confidence`

- `high` + matches あり → 採用、`final_stage: brief` で stop している
- `low` / `none` / matches 空 → launcher が evidence まで段上げ済み。それでも空なら **別キーワードを 1 度だけ試す** (キーワード変更は LLM 責務)。連打しない。

判定の内訳: vector と lexical (alias 完全一致 / coverage / ngram) を独立に採点し強い方を採る。vector は索引メタの `noise_baseline` (索引構築時に打刻される、ランダムなノード対の cosine 分布) からの **コーパス相対マージン** で判定する — 絶対 cosine はモデル依存で意味を持たないため。baseline の無い旧索引では絶対値の暫定バンドに落ちる (索引を再構築すれば相対判定になる)。

## `stages[*].output.query.standout` / evidence packet の `standout`

world_hints と同じ相対判定を手元 vault の matches にも適用したもの。

- `state`: `clear` = top1 が他候補から突出 (相対 gap ≥ 0.30。high でなければ 1 段格上げ済み) / `none` = 横並び / `single` = 候補 1 件以下で相対判定なし
- `gap_above_next`: (top1 − top2) / top1 の相対 gap (根拠)

## `stages[*].output.query.repeat.repeat_state`

- `excessive` (call_number ≥ 3) → **グラフ検索を打ち切り、コード / doc 直読みに移る**。`--call-number` は launcher が自動加算するので LLM 自己申告は不要。

## match の `state` / `state_note`

state が superseded/closed/abandoned/achieved のノードはランキングスコアが 0.6 倍に減点される (除外はしない = hard reject しない原則)。減点された match には `state_note` (例 `"superseded — refines 逆引きで後継を確認"`) が付くので、注記に従い後継/現役ノードを優先する。

## match の `relations` (brief)

edge 型の優先度順 (supersedes / refines / has_premise / sets_policy_for / constrains が先、discussed_in / documented_by が最後) に最大 8 件。3 つの形がある:

- `{relation, direction, node: {...}}` — 初出ノード。詳細つき (要約は ~120 字に短縮)
- `{relation, direction, id}` — 2 回目以降の出現。詳細は初出箇所か `matches[*].node` を見る (同じノードを 2 回ダンプしない)
- `{relation, direction, to: "vault:<slug>/<nodeId>"}` — 未解決の cross-vault 参照 stub。`GRAPHRAG_WORLD_DIR` 設定時は `cross_vault_resolved` に解決結果が付く

## evidence packet (`stages[*].output`, final_stage が evidence の時)

- `direct_evidence[*]` — ランク付き match。`node` は全文 (id/type/title/summary/path/state/provenance/short_label/display/aliases のうち在るもの)。**まずこれを使う**。
- `graph_context` — 近傍展開の文脈。supporting context 専用:
  - `graph_context.nodes` — **id をキーにした表**。値は `{type, title?, summary?(~140字), path?, state?}`。同じノードは 1 回だけ載る。direct_evidence に全文が出た match ノードは再掲しない (id は edges から引く)。「この id は何か」はこの表で確認できる (再クエリ不要)。
  - `graph_context.edges[*]` — `{depth, relation, from, to}` (from/to は id 参照)。近傍展開はノードあたり最大 ~10 本 (edge 型優先度順)・全体 ~40 本で打ち切られる。`vault:` 参照の端点は nodes 表に載らず id 参照のまま。
- `standout` — 上記と同じ相対判定。
- `answer_instructions` — 1 行の要約 + 本ガイドへのポインタ。

## `cross_vault_resolved` (`GRAPHRAG_WORLD_DIR` only)

When a matched node's edges (relations) contain a cross-vault ref (`vault:<slug>/<nodeId>`), `ask` resolves the target node's title/summary from the referenced vault and attaches it inline.

- `cross_vault_resolved[*].ref` — original cross-vault ref string (e.g. `"vault:billing/deliverable:billing:v2-release"`)
- `cross_vault_resolved[*].edge_type` — edge type (e.g. `"has_premise"`)
- `cross_vault_resolved[*].resolved` — resolved node's title/summary. `null` means resolution failed (vault absent or node not found).

**Action**: if title/summary suffices, no further ask needed. If deeper context is required, follow the pointer by running `ask "<question>" --vault <path>` against the target vault. This is a graph-structural pointer traversal, not a heuristic search — follow it proactively.

## `world_hints` (`GRAPHRAG_WORLD_DIR` 設定時のみ)

「他の vault X にも知識がありそう」のヒント。

- `hints[*].confidence` が `high` で手元の `match_confidence` が弱い時は、`hints[*].ask_command` (= `ask "<質問>" --vault <path>`) を実行して外の vault に掛けるのを検討する。掛けるかどうかは呼び手 (LLM) の判断 — 自動では掛からない。
- `freshness.state: stale` は写しが古い (取得時刻つき) という正直な申告。
- `standout` は相対判定: `clear` = top1 が他候補から突出 (その vault の領域に固有の問いの可能性が高い)、`crowd` = 候補が横並び (本当に複数に関係するか、どこにも無いかのどちらか — low ヒントを全部追う前にこれを見る)、`single` = 候補 1 つで相対判定なし。突出した top1 は絶対値が low でも high に格上げ済み (`gap_above_next` がその根拠)。
