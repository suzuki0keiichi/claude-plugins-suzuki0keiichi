# ask 出力フィールドガイド

`ask` の出力に含まれるフィールドの詳細。行動ルール (連打抑止・打ち切り判定) は SKILL.md §retrieval ladder に記載。

## `final_stage`

`brief` / `search` / `evidence` — どこまで自動段上げしたか。`evidence` まで行って空なら本当に無い。

## `stages[*].output.query.match_confidence`

- `high` + matches あり → 採用、`final_stage: brief` で stop している
- `low` / `none` / matches 空 → launcher が evidence まで段上げ済み。それでも空なら **別キーワードを 1 度だけ試す** (キーワード変更は LLM 責務)。連打しない。

## `stages[*].output.query.repeat.repeat_state`

- `excessive` (call_number ≥ 3) → **グラフ検索を打ち切り、コード / doc 直読みに移る**。`--call-number` は launcher が自動加算するので LLM 自己申告は不要。

## `next_action_hint`

そのままユーザー向け説明として使える文言。

## match の `state` / `state_note`

state が superseded/closed/abandoned/achieved のノードはランキングスコアが 0.6 倍に減点される (除外はしない = hard reject しない原則)。減点された match には `state_note` (例 `"superseded — refines 逆引きで後継を確認"`) が付くので、注記に従い後継/現役ノードを優先する。

## `world_hints` (`GRAPHRAG_WORLD_DIR` 設定時のみ)

「他の vault X にも知識がありそう」のヒント。

- `hints[*].confidence` が `high` で手元の `match_confidence` が弱い時は、`hints[*].ask_command` (= `ask "<質問>" --vault <path>`) を実行して外の vault に掛けるのを検討する。掛けるかどうかは呼び手 (LLM) の判断 — 自動では掛からない。
- `freshness.state: stale` は写しが古い (取得時刻つき) という正直な申告。
- `standout` は相対判定: `clear` = top1 が他候補から突出 (その vault の領域に固有の問いの可能性が高い)、`crowd` = 候補が横並び (本当に複数に関係するか、どこにも無いかのどちらか — low ヒントを全部追う前にこれを見る)、`single` = 候補 1 つで相対判定なし。突出した top1 は絶対値が low でも high に格上げ済み (`gap_above_next` がその根拠)。
