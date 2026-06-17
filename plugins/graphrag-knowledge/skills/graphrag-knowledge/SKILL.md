---
name: graphrag-knowledge
version: 3.10.0
description: プロジェクトの永続的な設計知識 (採用判断/却下案/制約/目的/リスク/運用知識と、それらを貫く横断構造) を vault を単一正本に安全に読み書きする。作業の最上流と一段落で発火する。【読み — 着手前に先に引く (コードやファイルを読む前にこれを起動)】① 「○○を実装/修正/改善/リファクタしたい」「○○がバグってる/動かない/エラー」「○○周りを整理/調査/レビュー/設計したい」と課題や依頼を受け取った直後、触る領域の Decision / Risk / Constraint / 運用知識を `ask` で先に引く (1発で網羅、連打しない)。② 「前回の続き」「引き継ぎ」「過去どう判断した」「なぜこの設計に」と経緯を問われた時。③ 「影響範囲」「どこに波及」と影響伝播を辿りたい時。【書き戻し — 一段落で能動的に (ユーザーの「覚えて」を待たない)】④ (言語マーカーが無くても行為で拾う) 実装/修正/改善/リファクタが一段落した・コミットする直前・変更を加え終えた時、その背後の採用判断/却下した案/踏んだリスク/運用ハマりをグラフに書き戻す。⑤ ユーザーや自分が「○○することにする」「採用しない/使えない」「今後はこう」と結論を述べた時、または「覚えておいて」「○○を記録」と明示された時。【初回】⑥ 未知のリポジトリを初回索引したい時。
---

# GraphRAG Knowledge

エージェントが vault (Obsidian Markdown) を単一正本として知識を溜め込み、雑な要求からでも網羅的に判断できるようにするためのスキル。retrieval 手順・focus 継続・読み書き境界・mutation 手順・報告形を規定する。

## 概要 / How to call

永続知識グラフを安全に読み書きする CLI。全 verb は単一 launcher 経由で呼ぶ:

```sh
node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts <verb> [args]
```

`${CLAUDE_PLUGIN_ROOT}` は plugin install 時に Claude Code が plugin の実体パスへ自動展開する（CLI も `references/` もこの配下に同梱される）。リポを直接 clone して開発する場合は plugin 環境変数が無いので、リポ root を作業ディレクトリにして `node --experimental-strip-types graphrag/cli.ts <verb>` と相対で叩く（dev 手順は CLAUDE.md / README 参照）。

- **読み**: `ask "<質問>"` (1 発で brief→evidence の自動段上げ。問い方の規律と `--gist` は §retrieval ladder)
- **書き**: `add-decision` / `add-ok` / `add-risk` / `add-investigation` / `add-rejected-option` / `add-constraint` / `add-goal` (引数だけで完結。エッジは各 verb のフラグで張る)、複雑な plan は `commit-mutation <plan.json>`
- **初回索引**: `carve --root <repo> --system <name>` (詳細は `${CLAUDE_PLUGIN_ROOT}/references/indexing-and-carving.md`)
- **状態確認**: `inspect`

primitive (段別細粒度操作) は §Primitive verbs 一覧 + `${CLAUDE_PLUGIN_ROOT}/references/cli-primitives.md`。

## グラフを使ったレビュー (姉妹 skill)

本 skill は読み書きの土台。グラフを背骨に**変更・提案を概念高度でレビュー**する派生 skill が3つある
(共通メソッドは `${CLAUDE_PLUGIN_ROOT}/references/graph-review-method.md`)。目的は QA でなく
コントローラビリティ (「大枠おまかせ、でも枠は超えるな」)。hard reject せず助言する:

- `/graphrag-knowledge:graphrag-design-review` — 設計案を実装前にグラフ (知識軸) と照合 (AI 実施)
- `/graphrag-knowledge:graphrag-pr-review` — PR/diff をグラフ (横断軸+File) と照合し概念デルタを3段で検出 (AI 実施)
- `/graphrag-knowledge:graphrag-review-doc` — 人間レビュアー向けの概念レベル説明資料 (HTML) を生成

## 不可分原則 (変更してはいけない設計境界)

1. **vault が単一正本**。知識は vault (frontmatter=正・本文=人間投影) に格納し、検索・索引・書き込みは全て vault を読む。`graph.json` は索引器の出力・往復検証用の中間表現であって正本ではない。通常の知識挿入で vault を手編集しない (`commit-mutation` / `add-*` が lock / OCC / 原子公開 / git commit を担保する)。
2. **LLM に生クエリを書かせない**。LLM が触れる面は2つだけ:
   - 読み: ランク済み JSON (`ask` / `brief` / `search` / `evidence` 出力)。
   - 書き: typed-add の CLI 引数、または mutation プラン JSON (`reason` / `nodes` / `edges`) を `commit-mutation` が **vault に**検証適用。
   この層を薄くする・生クエリ経路を LLM に露出する変更は設計違反。
3. **semantic は非交渉**。検索順位は lexical (完全一致 / 部分一致 / 単語カバー率を [0,1] に統合) と semantic (cosine を [0,1] にクランプ) を同じ重み (各最大 100) で合算する。lexical 単独フォールバック運用は設計しない (ベクトル索引が無ければ `ask` は明示エラーで停止)。
4. **vault は往復シリアライズ**。frontmatter (YAML) が正・本文は人間投影。vault import→build の往復等価テストが vault シリアライズ変更の唯一のゲート。

## Anti-patterns (やってはいけない)

- **「グラフを読む/辿る」を grep / glob / read に翻訳しない**。「グラフを読んで辿って」「過去どう判断したか」「なぜこの設計か」「影響範囲・波及」「前回の続き」等の依頼は、**vault の所在をファイル検索で探したり vault の `.md` を直接読んだりせず、まず `ask "<質問>"` で引く**。CLI は `.graphrag/.env` (walk-up) → `.env` → `.graphrag/vault` (walk-up) の順で vault を**自動発見**するので、vault パスを知らなくても `ask` は通る。見つからなければ大声でエラー停止する (§セットアップ前提) ので、黙ってファイル探索にフォールバックしない。env が ambient に見えないことを理由に grep に逃げるのは設計違反。
- **`graphrag/*.ts` のソースコードを grep / read しない**。LLM が必要とする情報は本ファイルと `references/` で完結する。`schema.ts` を読んで型を再導出するな (§スキーマ早見で十分)。`mutate-vault.ts` を読んで mutation plan 形を再導出するな (typed-add で大半が不要、残りは `${CLAUDE_PLUGIN_ROOT}/references/mutation-templates.md`)。CLI の呼び方を再導出するな (`node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts <verb>` ラッパで十分)。
- **Cypher / 生クエリを書かない**。LLM が触れる書き口は typed-add 引数と mutation plan JSON のみ。
- **`vault/` を直接編集しない**。正本は vault だが、手編集せず `commit-mutation` / `add-*` 経由で書く (CLI が lock / OCC / 原子公開 / git commit を担保する)。
- **重複ノードを作らない**。新規前に `ask` で**必ず**既存確認。`skip` / `update` / `supersede` / `review` を新規より優先。書き込み時には重複ゲート (`duplicate_check`、§Mutation Plan) が embedding 近接で最後の網を張るが、**ゲートがあるからと `ask` での事前確認を省かない** (ゲートは同型ノードの cosine 0.92 以上しか捉えない)。suspect を理解した上で別物として作る時だけ `--dup-ack <id[,id...]>` で明示的に通す。
- **session 内に閉じた "あれをやりたい" だけでグラフを汚さない**。永続するのは session を越えて再利用される結論・制約・リスク・運用知識のみ (詳細は §何を永続するか)。
- **vault の書き先を確認せずに書かない (worktree / サブディレクトリ事故)**。vault は cwd から上方向に自動発見される (§セットアップ前提)。worktree・サブディレクトリ・異なるブランチのチェックアウトで cwd が変わると、**意図しない vault に書く / vault が見つからない / 別リポジトリの vault を掴む** 事故が起きる。特に vault がプロジェクト外 (別リポジトリ) にある構成では、cwd が変わった瞬間に auto-discovery が vault を見失う。**session 内で初めて書く前に `inspect` で `vault_dir` を確認する**。想定と違えば `--vault <path>` フラグで明示するか、`.graphrag/.env` に `GRAPHRAG_VAULT_DIR` を書く (§セットアップ前提)。
- **vault ファイルを `git merge` しない**。知識グラフの並行作業をブランチで隔離した後、**git のファイル単位 merge は使わない**。git merge は「同じ判断を別の言葉で書いた重複」「系譜の無い Decision の衝突」「意味的に矛盾するエッジの両取り」を検出できない。merge は必ず `branch-merge` → 判断パケット読み → `commit-mutation` で main の vault に意味単位で適用する (§並行作業の枝分かれと意味的 merge、`${CLAUDE_PLUGIN_ROOT}/references/branch-merge.md`)。git merge / rebase で vault ファイルが機械的に統合された状態は**壊れた vault**であり、修復コストは意味的 merge の数倍かかる。

## セットアップ前提 (満たさないと retrieval は大声で停止する)

- **vault ディレクトリ**が在ること。読み・書き・索引は全て vault を見る。外部 graph DB は不要 (v3 は vault のみ)。vault の解決順は **shell env `GRAPHRAG_VAULT_DIR` > `.graphrag/.env` (cwd から上方向に walk-up) > プロジェクトの `.env` > 規約パス `.graphrag/vault` の自動発見** (cwd から上方向に探索, クロスプラットフォーム)。**`.graphrag/vault` に置けば env も `.env` も要らず素で `ask` が通る** (利用先の他ツール `.env` と干渉させたくない時の既定手段)。**vault が外部リポジトリにある場合は `.graphrag/.env` に `GRAPHRAG_VAULT_DIR=<絶対パス>` を書く**のが最も安定する (`.graphrag/.env` は walk-up で発見されるため、worktree やサブディレクトリからでも親の設定を拾える。リポジトリには `.gitignore` に `.graphrag/.env` を足しておく)。どれでも見つからなければ大声で停止する (黙って lexical fallback しない)。
- OpenAI 互換 embedding endpoint。設定が無ければ Ollama (`http://localhost:11434/v1`) と LM Studio (`http://localhost:1234/v1`) を自動検出。埋め込みモデルは `nomic-embed-text` に pin。endpoint が到達不能、または pin したモデルを `/v1/models` に出していない場合は、**欠落扱いで明示エラー停止**する。ごまかして探索を継続しない。
- **launcher は起動時に `.env` を 1 回読む**。全 verb (primitive / headline) が同じ env を見るので、verb ごとに env 不一致が起きない。verb 個別の env 上書きは CLI flag のみ。
- **出力先**は規約パス `.graphrag/vault` に置くだけで足り (env / `.env` 不要)、別の場所に置きたい時だけ env で上書きする (詳細は `${CLAUDE_PLUGIN_ROOT}/references/port-site.md`):
  - `GRAPHRAG_VAULT_DIR` = vault 正本パス (例 `./.graphrag/vault`)。env / `.graphrag/.env` / `.env` / `.graphrag/vault` 規約のいずれでも解決できない状態で `ask` / `commit-mutation` / `add-*` を叩くと**エラー停止**。
  - `GRAPHRAG_VAULT_MODE` = `readonly` | `direct` | `worktree` (vault が外部リポジトリにある場合の書き込みポリシー)。`readonly` は書き込み verb をエラー停止させる。`direct` は共有 vault にそのまま書く。`worktree` は vault リポにも git worktree を作って隔離書き込みする (事前に `vault-worktree --name <name>` で作成)。**未設定で vault が外部の場合、CLI は書き込みをエラー停止させ LLM にユーザー確認を強制する**。
  - `GRAPHRAG_GRAPH_JSON_PATH` = graph.json (索引器出力・往復検証用) 入出力パス (例 `./.graphrag/graph.json`)。`index` / `carve` / `vault-build` / `vault-import` を使う時のみ必要。

## focus 継続と read-only triage

- 文脈継続の単位は session ではなく focus / 進行中の調査 (Investigation)。同一 session でも focus が切り替われば新しい focus。
- resume / active-focus 確認 / next-action 抽出は read-only triage。triage の中でグラフ更新・vector index 更新・調査クリーンアップを始めない。
- triage は完了条件ではない。ユーザーが状態確認だけを求めた場合を除き、陳腐化した blockers や完了済み next_actions を stale 候補として報告し、本タスクへ進む。

## retrieval ladder と `ask` の打ち切り判定

要求に答える最小ステップから始め、ソースを開く前にこの順で登る。

1. resume / active focus: `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts brief --mode resume` (read-only triage)
2. **典型**: `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts ask "<質問>"` ── brief→evidence の自動段上げ + `--call-number` 自動加算 (LLM 手動付与不要)
3. 細かく制御したい時 (neighbors を変える等) は primitive (`search` / `evidence`) を直接叩く

GraphRAG が出したファイルを先に読み、`ask` 結果が不足する時だけ広げる。グラフ由来の事実と推論を混ぜない。欠けた知識は一時的な調査ギャップで、新規永続ノードではない。

### 問い方の規律 (一般語+ドメイン語の両建て、`--gist`)

検索順位は lexical (完全一致 / 部分一致 / 単語カバー率) と semantic (embedding cosine) の合算なので、**問いの語彙が当たり面を決める**。

- **一般語とドメイン語を両方入れる**。知識は日本語の一般語 (例「重複検出」「方針転換」) で蒸留されている一方、コードや実装名は英語のコード語 (例 `duplicate_check` / `supersede`) で書かれる。片方だけだと当たり面が痩せる。雑な日本語の問いでも、思い当たるコード語・型名を 1〜2 語添えると lexical と semantic の両方が効く (例: `ask "重複ノードを弾く duplicate_check の仕組み"`)。
- **`--gist "<想定答えの一行>"` で multi-query にする** (R6)。質問文だけでは引きにくい時、自分が期待する答えの一行を `--gist` に添えると、質問と gist を別々に埋め込んで両方で照合する (semantic は各 vector との cosine の max)。問いが抽象的・短い・言い換えが効く局面で効く。
  - 例: `ask "なぜ vault を単一正本にした" --gist "graph.json は索引器の中間表現であって正本ではない"`
- **`--graph-rerank on|off`** (R5、**既定 off**): 上位候補同士のグラフ隣接で押し上げる opt-in。2026-06-12 の実測で、実 vault では票がノード次数 (hub 度) を測ってしまい Investigation/会話ハブが正解の leaf を押し下げる net-negative を確認したため既定 off。島構造が均衡したグラフでだけ on を検討する。

### aliases の積み方 (知識ノードに別名を持たせる)

知識ノードの `aliases: string[]` は embedding と lexical の **aliasExact** (別名の完全一致) に配線済みで、**aliasExact は最も強い lexical 一致**として効く。引かれやすさを上げたいノードには、別名を `--aliases "a,b,c"` (カンマ区切り、typed-add 全 verb で指定可) で積む。

- **日本語の一般語と英語のコード語の両方**を入れる (問い方の両建てと表裏)。例: 重複ゲートの Decision なら `--aliases "重複検出,重複ノード,duplicate_check,dedupe"`。
- 後で雑に引く時に出てきそうな言い換え・略称・型名を素直に並べる。aliasExact は単独で confidence を high にできるので、「この語で引きたい」が分かっているノードほど効く。

### 「無い」判定と連打抑止 (ask 出力の読み方)

`ask` の出力に含まれる以下のフィールドを読み、連打せず切り上げる判断に使う。

- `final_stage`: `brief` / `search` / `evidence` ── どこまで自動段上げしたか。`evidence` まで行って空なら本当に無い。
- `stages[*].output.query.match_confidence`:
  - `high` + matches あり → 採用、`final_stage: brief` で stop している
  - `low` / `none` / matches 空 → launcher が evidence まで段上げ済み。それでも空なら **別キーワードを 1 度だけ試す** (キーワード変更は LLM 責務)。連打しない。
- `stages[*].output.query.repeat.repeat_state`:
  - `excessive` (call_number ≥ 3) → **グラフ検索を打ち切り、コード / doc 直読みに移る**。`--call-number` は launcher が自動加算するので LLM 自己申告は不要。
- `next_action_hint`: そのままユーザー向け説明として使える文言。
- match の `state` / `state_note`: state が superseded/closed/abandoned/achieved のノードはランキングスコアが 0.6 倍に減点される (除外はしない = hard reject しない原則)。減点された match には `state_note` (例 `"superseded — refines 逆引きで後継を確認"`) が付くので、注記に従い後継/現役ノードを優先する。
- `world_hints` (`GRAPHRAG_WORLD_DIR` 設定時のみ出る): 「他の vault X にも知識がありそう」のヒント。`hints[*].confidence` が `high` で手元の `match_confidence` が弱い時は、`hints[*].ask_command` (= `ask "<質問>" --vault <path>`) を実行して外の vault に掛けるのを検討する。掛けるかどうかは呼び手 (LLM) の判断 — 自動では掛からない。`freshness.state: stale` は写しが古い (取得時刻つき) という正直な申告。
  - `standout` は相対判定: `clear` = top1 が他候補から突出 (その vault の領域に固有の問いの可能性が高い)、`crowd` = 候補が横並び (本当に複数に関係するか、どこにも無いかのどちらか — low ヒントを全部追う前にこれを見る)、`single` = 候補 1 つで相対判定なし。突出した top1 は絶対値が low でも high に格上げ済み (`gap_above_next` がその根拠)。

## 典型 Recipe

| やりたい事 | コマンド |
|---|---|
| 雑な問いに網羅的に答える | `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts ask "<質問>"` |
| 単一 Decision を永続化 | `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts add-decision --system <s> --slug <slug> --title "..." --summary "..." --evidence file:<s>:<path>` |
| 失敗した試みを記録 | `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts add-rejected-option --system <s> --slug <slug> --title "<試した案>" --summary "<失敗モード>" --rejected-in-favor-of decision:<s>:<chosen>` |
| 運用ハマりを記録 | `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts add-ok --system <s> --slug <slug> --title "..." --summary "..." --evidence file:<s>:<path>` |
| 将来踏みそうなリスクを記録 | `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts add-risk --system <s> --slug <slug> --title "..." --summary "..." --evidence file:<s>:<path>` |
| 調査エピソードを記録 | `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts add-investigation --system <s> --slug <slug> --title "..." --summary "..." --raw-content "代表コミット:\n- 2026-MM-DD <hash> <subject>"` |
| 制約 (不変条件) を記録 | `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts add-constraint --system <s> --slug <slug> --title "..." --summary "..." --constrains <id,...>` (`--constrains` 必須 ≥1、宛先 Decision\|File\|OK) |
| 目的・到達点を記録 | `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts add-goal --system <s> --slug <slug> --title "..." --summary "..." [--refines <goal-id>] [--state planned\|active\|achieved\|abandoned]` |
| 複雑な plan を確定 (vault に検証適用) | `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts commit-mutation <plan.json>` |
| 初回索引 + 概念候補抽出 + 品質ゲート | `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts carve --root <repo> --system <name>` (詳細は `${CLAUDE_PLUGIN_ROOT}/references/indexing-and-carving.md` を必ず参照) |
| 状態確認 (env / artifacts) | `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts inspect` |

`add-*` の `--evidence` は schema 上必須 (Decision/RejectedOption/Risk/OK は source backing が無いと validation reject)。最低 1 つの `file:<system>:<path>` を渡す。**例外**: `add-constraint` は Constraint が documented_by 不可・evidence 不要なので `--evidence` を取らず、代わりに `--constrains <id,...>` (宛先 Decision|File|OK) を必須 ≥1 で取る。`add-goal` も evidence 不要 (出所に接地するなら `--derived-from <conversation/investigation-id>`)。

全 typed-add verb はエッジをフラグで張れる (id は既存の決定論命名規則と同形。文法違反の組はフラグ受理時に throw)。主なもの:

- `add-decision`: `[--sets-policy-for <id,...>]` (sets_policy_for) / `[--premise <id,...>]` (has_premise) / `[--from-investigation <id>]` (led_to: investigation→新 Decision) / `[--refines <decision-id>]` / `[--reduces-risk <risk-id,...>]`
- `add-ok`: `[--premise <id,...>]` / `[--refines <id>]` / `[--reduces-risk <id,...>]`
- `add-risk`: `[--risks-in <id,...>]`
- `add-constraint`: `--constrains <id,...>` (必須 ≥1)
- `add-goal`: `[--refines <goal-id>]` / `[--derived-from <id>]` / `[--state planned|active|achieved|abandoned]`
- 全 verb: `[--aliases "a,b,c"]` (§retrieval ladder の aliases) / `[--description "..."]` / `[--dup-ack <id[,id...]>]`

## Headline verbs (連鎖、1 コマンドで複数段)

- `ask "<q>"` ── brief→search→evidence の自動段上げ + `--call-number` 自動加算 (vault を読む)
- `carve --root <repo> --system <name>` ── index → vein-hint → policy-suggest → carving-check 連鎖。**索引直後は File 要約も Pocket/Stratum candidate 要約も「構成要素サマリ」の機械テンプレ (`summary_provisional`)。必ず読んで「意味」(何をする/何のため/どの関心) の要約に書き換え `summary_provisional` を外す**(残すと vein-hint 拒否・carving-check ERROR。テンプレ要約は embedding を構成要素語で汚染し縦串検出を無意味化する)。**Vein (横断関心) の発見は LLM の概念的モデリングが主役** — vein-hint の機械候補は盲点チェック用 (`conceptual-pass.md` §2)。Pocket/Stratum は indexer が canonical 地質名で出す。
- `commit-mutation <plan.json>` ── **vault writer 経由** (lock → OCC → vault import → normalize/validate → 原子 delta 書込 → vector-index 更新 (非致命) → git commit)。commit 失敗は all-or-nothing でロールバック
- `add-decision` / `add-ok` / `add-risk` / `add-investigation` / `add-rejected-option` / `add-constraint` / `add-goal` ── 引数だけで plan 組み立て + **vault に** apply。エッジは各 verb のフラグで張る (§典型 Recipe の evidence 注記、フラグ一覧)。`add-investigation` の state 既定は `"active"` (`--state` で上書き可)。`add-goal` は `--state planned|active|achieved|abandoned` (既定 state なし)。`add-constraint` は `--constrains <id,...>` 必須 (evidence は取らない)。重複ゲートの suspect を別物として通す時は `--dup-ack <id[,id...]>` (§Mutation Plan)
- `inspect` ── env + artifacts (vault / graph.json / vector-index / world) の状態確認 (1 JSON)

## Primitive verbs (段別、細粒度制御)

詳細 flag は `${CLAUDE_PLUGIN_ROOT}/references/cli-primitives.md`。

| verb | 役割 |
|---|---|
| `brief` | 概要応答 (resume / query mode、vault を読む) |
| `search` | ランク済み近傍展開 (vault を読む) |
| `evidence` | 出所付き answer packet (vault を読む) |
| `index` | 決定論索引 (git ls-files + role 分類 + 依存) → graph.json |
| `vector-index` | vector index 構築 (vault から) |
| `vault-build` | graph.json → vault (索引器出力を vault 化する時のみ。通常書込は `commit-mutation` が直接 vault に書く) |
| `vault-import` | vault → graph.json (round-trip 検証用) |
| `vein-hint` | Vein の機械ヒント (embedding 近接クラスタリング)。LLM のモデリング後の盲点チェック用 |
| `edge-suggest-policy` | sets_policy_for 候補抽出 |
| `carving-check` | carving 品質ゲート |
| `branch-merge` | vault git ブランチの意味的 merge 分析 (3状態の差分→衝突→判断パケット、読み取り専用)。手順は `${CLAUDE_PLUGIN_ROOT}/references/branch-merge.md` |
| `world-refresh` | cross-vault 用 world-cache (各 vault の自己紹介の写し+embedding) を再構築。`GRAPHRAG_WORLD_DIR` 設定時 `ask` が `world_hints` を添える。出力に各 vault の VAULT.md mtime とノード数を含め、mtime が 45 日より古い vault には `intro_hint` (自己紹介が蓄積に対して古い可能性の注意) を添える |
| `carving-allow` | `.graphrag/carving.json` (carving 免除設定) の管理: `add --path <p> --reason <r>` / `remove --path <p>` / `list` / `migrate --graph <path>`。carving.json は Stratum/Vein/Pocket と同格の**人間所有の概念層** — LLM は提案のみ可、追記は user 承認後 |
| `harvest-history` | `--root <repo>` の git 履歴から決定論抽出 (書き込みなし): revert コミット → RejectedOption candidate、HACK/FIXME/WORKAROUND/XXX マーカー → OperationalKnowledge/Risk candidate。candidate JSON を返すのみで、採否判断と typed-add は LLM が行う |
| `staleness-check` | 知識ノード (Decision/Constraint/Risk/OK) の documented_by/sets_policy_for/constrains が指す File について、ノードの generated_at 以降のコミット数を数え、`--threshold-commits` (既定 5) 以上を candidate 列挙 (読み取り専用・意味判断なし。意味判断は人間起動の audit に委ねる) |

### Headline と Primitive の使い分け

- **Headline**: 1 コマンドで複数段を済ませる sugar。`ask` は brief→search→evidence、`carve` は索引→suggest 系→品質ゲート、`commit-mutation` は mutation 後段全部、`add-*` は引数だけで知識追加。
- **Primitive**: 各段を直接叩く。neighbors を変えたい / evidence packet だけ単独で欲しい / 索引だけ再生成したい / carving-check を vector ありで再走したい、等の細かい制御に。

両者は機能的に重複する部分があるが選択軸が違う。LLM が「即答 / 典型」と判断したら headline、「制御 / 探索 / 再現」と判断したら primitive を選ぶ。優劣は無い。

## 並行作業の枝分かれと意味的 merge (vault branch)

知識グラフの並行作業は **vault の git ブランチ**で隔離し、merge は git のファイル単位でなく**ノード/エッジ単位で意味を見て**行う (言い換えた重複・系譜の無い Decision を git は取りこぼす)。`branch-merge --branch <ref>` が3状態 (分岐点/枝/main) の差分と衝突を判断パケット (JSON) として返す (読み取り専用)。解決は LLM がパケットを読み、統合後の姿を mutation plan に組んで `commit-mutation` で main の vault に適用する。手順詳細は `${CLAUDE_PLUGIN_ROOT}/references/branch-merge.md`。

## スキーマ早見

`graphrag/schema.ts` の `NODE_TYPES` (12) と `EDGE_TYPES` (14) が正本。

**ノード型 (12)**:

- root ノード型は無い (v3.3 で撤去)。**scope は vault 境界自体が担う** (vault=scope)。
- **`File`**: 索引されたソースファイル。要約が機械テンプレのままだと `summary_provisional: true` が立つ — ファイルを読んで本物の要約に書き換えたら外す (retrieval 品質の主レバー)。
- **知識 (8)**:
  - `Decision` = 選択肢が複数ある中から一つを選んだ判断 (「JWT を使う」「pnpm を採用する」)。
  - `OperationalKnowledge` (略称 OK) = やってみて分かった運用上の注意・コツ・ハマりどころ (「JWT 更新は24時間設定が安定」「Ollama は初回ロードが遅い」)。**判断基準: 選択肢から選んだ → Decision、運用で得た知見 → OK。迷ったら Decision** (後から構造化しやすい)。
  - `RejectedOption` = 検討して却下した案。同じ失敗を繰り返さないための一級ノード。
  - `Constraint` = 外部要因で変えられない不変条件 (法令・SLA・技術的制約)。判断を伴うものは Decision + Constraint への has_premise で分解する。
  - `Goal` = システムの目的因・到達点 (v2 の Requirement を吸収)。
  - `Risk` = 将来踏みそうな脅威。解消は reduces_risk エッジで表現 (Risk 自体に state は無い)。
  - `Investigation` = 目的を持った調査 (state: active/closed で閉じられる)。
  - `ConversationChunk` = 生の対話記録。AI との会話・会議メモ・Slack 議論など、時点のエピソード記録。Investigation が「まとまった調査行為」なのに対し、ConversationChunk は「その場の生ログ」。閉じる概念が無い。
- **軸2 / 横断構造 (3)**: ソフトウェア構造を3つの直交した軸で捉える。
  - `Stratum` (= Layer, 地層) = 深さの層。app 層・infra 層など水平に積もる依存ピラミッド。
  - `Vein` (= Concern, 鉱脈) = 横串の関心。auth・logging など層を貫いて走る共通関心。
  - `Pocket` (= Component, 鉱塊) = 部品。payment module など局所に凝集した実装の塊。
  - 正式名は地質メタファー (Stratum/Vein/Pocket) だが、**Layer / Concern / Component も alias として使える** (`canonicalType` が正規化する)。チーム内で通じやすい方で呼んでよい。**indexer は canonical 地質名 (`Pocket`/`Stratum`、id `pocket:`/`stratum:`) で出す**。

**エッジ型 (14)** と許容組 (from-type → to-type):

- `documented_by`: Decision|RejectedOption|Risk|OK|Investigation → File
- `evidenced_by`: Stratum|Vein|Pocket → File
- `derived_from`: Decision|RejectedOption|Risk|OK|**Goal**|Investigation → ConversationChunk|Investigation (**出自**=「この知識はどの会話/調査から生まれたか」の歴史記録。`has_premise` との違い: has_premise は論理依存「消えたら壊れる」、derived_from は出自「どこから来たか」。Investigation が両方の宛先に現れるが、意味は異なる)
- `discussed_in`: ConversationChunk → Investigation
- `led_to`: Investigation → Decision
- `rejected_in`: RejectedOption → Investigation
- `supersedes`: Decision|OK → RejectedOption
- `refines`: Decision|OK → Decision|OK / **Goal → Goal**
- `has_premise`: Decision|OK|Investigation → Decision|OK|Constraint|Risk|**Goal**
- `constrains`: Constraint → Decision|File|OK
- `sets_policy_for`: Decision → File|Investigation|OK|**Stratum|Vein|Pocket** (横断構造宛=「この部品/層/関心の全体に効く方針」。正直でいられる一番低い高度を選ぶ: File→Pocket→Stratum/Vein。vault 全体規範は CLAUDE.md/AGENTS.md へ)
- `reduces_risk`: Decision|OK → Risk
- `risks_in`: Risk → Decision|File|OK|Investigation|**Stratum|Vein|Pocket** (横断構造宛=「この部品/層/関心に宿るリスク」。高度のはしごは sets_policy_for と同じ)
- `temporary_relation_candidate`: 任意の知識ノード → 任意の知識ノード (mutation 前の暫定マーカー)

**ID 規約**: `<typeSlug>:<system>:<slug>` (例 `decision:graphrag:vault-single-source`)。`<system>` は **id の名前空間ラベル** (System ノードは作られない)。typed-add CLI の `--system` もこのラベルを指す。

**state 語彙** (`schema.ts` の `STATE_VOCABULARY` が正本、`validateGraph` で強制):

| 型 | 許される state |
|---|---|
| `Investigation` | `"active"` \| `"closed"` (`add-investigation` の既定は `"active"`、`--state` で上書き可) |
| `Decision` / `OperationalKnowledge` | `"superseded"` のみ (state 無し = 現役) |
| `Goal` | `"planned"` \| `"active"` \| `"achieved"` \| `"abandoned"` |

上記以外の型に state があれば validation failure。語彙外の値も failure (typo ゾンビ検出)。state 無しは常に合法。retrieval は終端 state (superseded/closed/abandoned/achieved) のノードを除外せずスコア 0.6 倍に減点し `state_note` を添える (§「無い」判定と連打抑止)。

**方針転換レシピ** (Decision を覆す正規手順。文法は変えない — `supersedes` は Decision|OK → RejectedOption のまま):

1. 新 Decision を作成し、mutation plan で `refines`: 新→旧 を張る (系譜)。
2. 同じ plan で旧 Decision を op:update で `state: "superseded"` にする。
3. 反転で捨てたアプローチが再誘惑されうる場合のみ RejectedOption を新設し、新Decision -`supersedes`-> それ を併設する。

旧ノードへの `has_premise` 流入エッジはそのまま生きる (系譜保存)。plan 雛形は `${CLAUDE_PLUGIN_ROOT}/references/mutation-templates.md`。

## Mutation Plan

```typescript
{
  reason: string,                   // 必須、なぜこの mutation を出すか
  nodes: Array<{ op: "create"|"update"|"delete", id, type?, title?, summary?, description?, raw_content?, updates? }>,
  edges: Array<{ op: "create"|"delete", id, type, from, to }>,
  duplicate_ack?: string[]          // 重複ゲートの suspect (既存ノード id) を確認済みとして通す時のみ
}
```

- `updates` の値に `null` を渡すと**そのフィールド自体を削除**する (例: `{ "state": null }` で state 取り下げ)。
- `summary` = 1 行見出し (frontmatter に残る・検索の主担体)。
- `description` = そのノードを蒸留した散文 (vault body `## 説明` に round-trip marker 付きで出る・embedding にも入る)。**原則どのノードにも書く** (summary 丸写しになるなら省くが、空のまま放置しない)。書き分け:
  - **集合系 (Vein 等が特に重要)**: 構成要素の列挙ではなく、**まとまりとして捉えたとき結局それが何なのか (what の正体・意味)**。要素を見れば分かることではなく、集合として初めて立ち上がる意味を書く。
  - **判断系 (Decision/Risk/Constraint/RejectedOption/OperationalKnowledge)**: **なぜそう決めたか**。
- `raw_content` = 生の一次情報 (どんな会話をしてどう決まったか・会話ログ・Slack 等の URL)。**判断系でも捨てない**: 容量は小さく、後で「なぜ」を辿る一次ソースになる。判断系ノード自身の `raw_content` に入れるか、raw_content を持つ ConversationChunk/Investigation を source backing (`documented_by`/`derived_from`) として張って残す (distilled ノードの source backing 要件も満たす)。`description` を入れないノートは body に `## 説明` 見出しを出さない (summary は frontmatter で読める)。

`commit-mutation` (および typed-add) が `validateGraph` 通過を強制する (未知型・未許可組・evidence 不足・id 重複・state 語彙違反を reject)。**書込は全て vault に向かう** (`commit-mutation` / `add-*` が vault writer 経由で原子的に書く)。

| やりたい事 | 推奨手段 (全て vault へ書く) |
|---|---|
| Decision/OK/Risk/Investigation/RejectedOption/**Goal/Constraint** の新規 1 件 | **typed-add headline** (`add-*`) ── 引数だけ、JSON 不要 (Goal/Constraint も `add-goal`/`add-constraint` で足りる) |
| Vein / Stratum / Pocket の新規、または複数ノード/エッジを一括で組む複雑ケース | `commit-mutation <plan.json>` ── 雛形は `${CLAUDE_PLUGIN_ROOT}/references/mutation-templates.md` |
| Update (既存ノードの summary 等) | `commit-mutation <plan.json>` ── 雛形は `${CLAUDE_PLUGIN_ROOT}/references/mutation-templates.md` |
| Delete (cascade あり) | `commit-mutation <plan.json>` ── 雛形は `${CLAUDE_PLUGIN_ROOT}/references/mutation-templates.md` |
| 方針転換 (Decision を覆す) | `commit-mutation <plan.json>` ── レシピは §スキーマ早見、雛形は `${CLAUDE_PLUGIN_ROOT}/references/mutation-templates.md` |

### 書き込み時重複ゲート (duplicate_check)

vault writer の検証段で、op:create の知識/横断ノード (Decision/RejectedOption/Constraint/Goal/Risk/OperationalKnowledge/Investigation/Vein/Pocket/Stratum。File と ConversationChunk は対象外) を `title+" "+summary` の embedding で vault の vector index 内の**同型ノード**と照合する (cosine threshold 0.92)。

- **ヒット時**: plan の `duplicate_ack: string[]` (既存ノード id 列) が全 suspect を覆っていなければ all-or-nothing で reject。`failures` に `duplicate-suspect: <new-id> ~ <existing-id> (similarity 0.94)` 形式で列挙される。suspect の `ask`/`evidence` で中身を確認し、`update`/`supersede` で済むなら新規を取り下げる。本当に別物と判断した時だけ ack して再実行する。
- **typed-add からは** `--dup-ack <id[,id...]>` で plan の `duplicate_ack` に注入する。
- **embedding endpoint 不達 / vector index 不在**: 非致命スキップ (`index_status` と同じ扱い)。ゲートが skip された書き込みは `ask` での事前確認だけが守り。
- **出力**: `duplicate_check: { status: "ok"|"acked"|"skipped", reason?: string, suspects: [{new_id, existing_id, similarity}] }`。

このゲートは**最後の網**であって `ask` での事前確認の代替ではない (§Anti-patterns「重複ノードを作らない」)。

## 何を永続するか / 何時 LLM が能動的に書きにいくか

永続するのは session を越えて再利用される結論・制約・リスク・運用知識のみ。途中の試行錯誤は raw_content の中に閉じ込める。

### 何時 LLM が能動的に書きにいくか (Proactive Persistence)

ユーザーに「覚えて」と言われるのを待たない。次の言語マーカー**または行為**が現れたら即 `add-*` で書く。重複確認 (`ask` / `brief`) を**先に**経る (§Anti-patterns)。

- **実装/修正/改善/リファクタが一段落した (行為トリガー)**: コミットする直前、または変更を加え終えてユーザーに報告する時。その変更の背後にある採用判断・却下した代替案・踏んだリスク・気づいた運用ハマりを書き戻す。**無言の行為なので意識して拾う** (言語マーカーより見落としやすい)。
  → `add-decision` / `add-rejected-option` / `add-risk` / `add-ok` のいずれか (該当するもの)
- **ユーザーが結論を述べた**: 「○○することにする」「○○は採用しない」「○○は使えない」「今後はこう」
  → `add-decision` / `add-rejected-option` / `add-risk` のいずれか
- **LLM 自身が回答で結論を述べた**: 「○○すべき」「○○は避けるべき」と未来時制で述べた瞬間
  → 同上
- **失敗した実体ある試行 (= RejectedOption + 任意で Investigation)**:
  「approach X を試して制約 Y でハマって撤退」のような会話。**これは特に拾え**。ソースコード以外に残らない第 1 種で、書かないと同じ失敗を繰り返す。
  → `add-rejected-option --title "<試した案>" --summary "<失敗モード>" --rejected-in-favor-of <選んだ Decision id>`
  → 経緯が複数イベントなら `add-investigation` も併発し led_to で接続

### 書き込みの vault isolation ガード

vault が外部リポジトリにあり `GRAPHRAG_VAULT_MODE` が未設定の場合、`add-*` / `commit-mutation` は**エラー停止**する。エラーメッセージに従い、ユーザーに mode を確認して `.graphrag/.env` に設定する (`readonly` = 読み専用で書き込み拒否、`direct` = 共有 vault にそのまま書く、`worktree` = vault リポにも worktree を作って隔離書き込み)。**mode 設定済みなら CLI が自動で従うため確認不要**。

### 書き込み出力の suggestions の扱い方

`add-*` / `commit-mutation` は書き込み後、出力に `suggestions` オブジェクトを添える (全て **suggest-only・非致命**。index / endpoint 不在時は各提案を空+reason 付きで skip し、書き込みは決して止めない)。**提案は判断して確定するか、理由を持って見送る。自動では張られない** — これが境界 (エッジの自動付与はしない・確定は LLM/人間)。

- `suggestions.binding`: 作成した Decision/OK/Risk/Constraint について、vector index の File と embedding 照合した紐付け候補 (型ごと固定: Decision→sets_policy_for / Risk→risks_in / OK→documented_by / Constraint→constrains)。各候補に similarity と「そのまま実行できる確定手段」(typed-add フラグ or plan 断片) が付く → 妥当なら **その手段で確定**する。
- `suggestions.relations`: 同型ノードの cosine が [0.80, 0.92) 帯にある関係候補 (refines / has_premise / supersede のどれかは **LLM が判断** と note 付き)。中身を見て該当する関係を張るか見送る。
- `suggestions.led_to`: Decision 作成時に graph 内の `state:"active"` な Investigation を列挙 → その調査から導かれた Decision なら led_to を張る。
- `suggestions.premise_candidates`: ask-trail の直近ヒットのうち Decision/Constraint/Goal/OK 型 → 前提なら has_premise を張る。
- `suggestions.binding_debt`: bind 無し knowledge ノード総数 (carving-check #9 と同定義、Constraint 拡張込み) を整数 1 つで。増えていたら未紐付けの知識が溜まっている合図。

いずれも「判断して確定 or 理由を持って見送る」。提案をそのまま無言で放置しない (見送るなら見送る理由が言える状態にする)。

- session 内でしか使わない一時的な探索メモ
- 数分で戻せる scratch (変数名いじり、lint 通すための一時変更等)
- 「未来時制で述べられていない」その場限りの観察

## Topology Gap Review (不具合・見落とし発見時のグラフ構造自省)

不具合や考慮漏れが見つかった時、次の問いを自問する:

1. **これはグラフに適切な構造があれば回避できたか?** — 本来あるべき Vein/Pocket やエッジが存在していれば、`ask` でその Constraint/Risk が引っ張れて防げた不具合か。
2. **あるべきノードが存在しない状態か?** — 既にある Constraint/Decision が別の操作経路に届いていないだけ (エッジの穴) か、そもそも横断的な関心 (Vein/Pocket) が構造化されていないか。

**穴のパターン**: 操作 A に Constraint C が正しく適用されているが、同じリソース R を触る操作 B への C→R→B の経路がグラフに無い。原因は R を表す Vein/Pocket の不在、またはそこへのエッジ欠損。

**該当した場合**: 不足している構造 (Vein/Pocket + エッジ) を `commit-mutation` で補い、同種の考慮漏れを将来の `ask` で防げるようにする。このフィードバックがグラフの学習ループを閉じる — 検索精度の改善ではなく、グラフのトポロジー自体を育てる行為。

**タイミング**: 不具合修正・レビュー指摘対応・「なぜグラフから引けなかったのか」とユーザーに問われた時。Drift Reconciliation (下記) と似ているが、こちらは「グラフに書いてある内容の古さ」ではなく「グラフに書かれるべき構造の不在」を扱う。

## Drift Reconciliation (意図せず気付いた乖離)

現タスクで該当ノードを retrieval 経由で読み、かつ同領域のコードも read した文脈が揃った時のみ成立する。「グラフ記述と現ソースが食い違ってる」と気付いても、書き直しを LLM 判断で勝手にやらない (full investigation していないので誤判定リスクが高く、誤った update/delete は元情報を失う)。構造化フォーマット (`[u]pdate / [d]elete / [s]kip / [i]nvestigate` の4択) でユーザーに提示し、裁定後に `commit-mutation` で書き戻す。提示フォーマット詳細は `${CLAUDE_PLUGIN_ROOT}/references/drift-reconciliation.md`。systematic な乖離 audit はこれと別物 — ユーザーから明示的に頼まれた時だけ。

## 報告形 (ユーザー向け)

グラフ変更を node ID / edge ID の羅列で報告しない。自然言語で: 変更した知識 / つないだ関係 / 残した理由 / 検証状態 (carving-check・vector index) を書き、ID は説明の後に括弧参照で添える。報告は「で、何をするのか」まで接続する。

`commit-mutation` の出力 (`summary.changed_nodes` / `cascaded_edge_ids` / `head` (git commit) / `index_status` (vector-index 更新)) は機械形式 JSON。**そのまま user に渡さず**、自然言語に変換し「何の知識を入れたか / どう繋いだか / なぜ残したか / 検証通ったか (索引・commit)」を述べ、id は末尾括弧参照に降ろす。

## 参照リンク

- `${CLAUDE_PLUGIN_ROOT}/references/cli-primitives.md`: primitive 全 flag リファレンス
- `${CLAUDE_PLUGIN_ROOT}/references/mutation-templates.md`: Vein / Stratum / Pocket / Update / Delete / 方針転換 plan 雛形 (Goal / Constraint は `add-goal` / `add-constraint` で足りるが、複雑ケース用の雛形も残置)
- `${CLAUDE_PLUGIN_ROOT}/references/branch-merge.md`: vault branch の意味的 merge 手順 (branch-merge → 判断パケット → commit-mutation)
- `${CLAUDE_PLUGIN_ROOT}/references/drift-reconciliation.md`: drift 提示フォーマット詳細とユーザー裁定後の反映
- `${CLAUDE_PLUGIN_ROOT}/references/port-site.md`: 移植時のみ参照 (env / escalation / graphName / 出力先)
- `${CLAUDE_PLUGIN_ROOT}/references/indexing-and-carving.md`: **初回索引と概念化パスは必ず参照**
- `${CLAUDE_PLUGIN_ROOT}/references/carving-rationale.md`: 12 ノード型 + エッジ文法の中核価値、RejectedOption 一級、Stratum≠Vein≠Pocket (地質メタファー)、Symbol 非ノード
- `${CLAUDE_PLUGIN_ROOT}/references/interpretation-guidance.md`: File 解釈 summary の汎用ガイダンス (retrieval 品質の主レバー)
- `${CLAUDE_PLUGIN_ROOT}/references/conceptual-pass.md`: 概念解釈パスの手順
- `${CLAUDE_PLUGIN_ROOT}/references/carving-rules.md`: carving の品質ガード (連番 slug 禁止 / 網羅性 / 重複検出 / 自動検証コマンド)
- `${CLAUDE_PLUGIN_ROOT}/references/indexer-redesign-notes.md`: indexer エッセンス・再設計指針・実力 eval
