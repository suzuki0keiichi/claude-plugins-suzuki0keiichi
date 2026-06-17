---
name: graphrag-knowledge
version: 3.11.0
description: プロジェクトの永続的な設計知識 (採用判断/却下案/制約/目的/リスク/運用知識と、それらを貫く横断構造) を vault を単一正本に安全に読み書きする。作業の最上流と一段落で発火する。【読み — 着手前に先に引く (コードやファイルを読む前にこれを起動)】① 「○○を実装/修正/改善/リファクタしたい」「○○がバグってる/動かない/エラー」「○○周りを整理/調査/レビュー/設計したい」と課題や依頼を受け取った直後、触る領域の Decision / Risk / Constraint / 運用知識を `ask` で先に引く (1発で網羅、連打しない)。② 「前回の続き」「引き継ぎ」「過去どう判断した」「なぜこの設計に」と経緯を問われた時。③ 「影響範囲」「どこに波及」と影響伝播を辿りたい時。【書き戻し — 一段落で能動的に (ユーザーの「覚えて」を待たない)】④⑤ 実装一段落・結論確定・却下・記録指示で書き戻す (詳細は §何を永続するか)。【初回】⑥ 未知のリポジトリを初回索引したい時。
---

# GraphRAG Knowledge

エージェントが vault (Obsidian Markdown) を単一正本として知識を溜め込み、雑な要求からでも網羅的に判断できるようにするためのスキル。retrieval 手順・focus 継続・読み書き境界・mutation 手順・報告形を規定する。

## 概要 / How to call

永続知識グラフを安全に読み書きする CLI。全 verb は単一 launcher 経由で呼ぶ:

```sh
node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts <verb> [args]
```

以降 `$CLI` = 上記 launcher、`$REF` = `${CLAUDE_PLUGIN_ROOT}/references`。

verb は 読み(`ask`)・書き(`add-*` / `commit-mutation`)・索引(`carve`)・確認(`inspect`) の4類。詳細は §典型 Recipe / §Headline verbs。primitive (段別細粒度操作) は §Primitive verbs + `$REF/cli-primitives.md`。

## グラフを使ったレビュー (姉妹 skill)

本 skill は読み書きの土台。グラフを背骨に**変更・提案を概念高度でレビュー**する派生 skill が3つある
(共通メソッドは `$REF/graph-review-method.md`)。目的は QA でなく
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

- **「グラフを読む/辿る」を grep / glob / read に翻訳しない**。vault の `.md` を直接読まず `ask` で引く。CLI が vault を自動発見する (§セットアップ前提)。vault パスを知らなくても `ask` は通り、見つからなければエラー停止。grep fallback は設計違反。
- **`graphrag/*.ts` のソースコードを grep / read しない**。LLM が必要とする情報は本ファイルと `$REF/` で完結する。`schema.ts` を読んで型を再導出するな (§スキーマ早見で十分)。CLI の呼び方を再導出するな (`$CLI <verb>` で十分)。
- **`vault/` を直接編集しない**。正本は vault だが、手編集せず `commit-mutation` / `add-*` 経由で書く (CLI が lock / OCC / 原子公開 / git commit を担保する)。
- **重複ノードを作らない**。新規前に `ask` で**必ず**既存確認。`skip` / `update` / `supersede` / `review` を新規より優先。書き込み時には重複ゲート (`duplicate_check`、§Mutation Plan) が embedding 近接で最後の網を張るが、**ゲートがあるからと `ask` での事前確認を省かない** (ゲートは同型ノードの cosine 0.92 以上しか捉えない)。suspect を理解した上で別物として作る時だけ `--dup-ack <id[,id...]>` で明示的に通す。
- **vault の書き先を確認せずに書かない (worktree / サブディレクトリ事故)**。worktree・サブディレクトリ・異なるブランチのチェックアウトで cwd が変わると、意図しない vault に書く事故が起きる。**session 内で初めて書く前に `inspect` で `vault_dir` を確認する**。想定と違えば `--vault <path>` フラグで明示するか、`.graphrag/.env` に `GRAPHRAG_VAULT_DIR` を書く。
- **vault ファイルを `git merge` しない**。git merge は意味的重複・系譜欠損・矛盾エッジを検出できず壊れた vault を生む。merge は `branch-merge` → 判断パケット → `commit-mutation` で意味単位適用 (§並行作業、`$REF/branch-merge.md`)。
- **session-local な探索メモでグラフを汚さない** (§何を永続するか)。

## セットアップ前提 (満たさないと retrieval は大声で停止する)

- **vault ディレクトリ**が在ること。解決順: **shell env `GRAPHRAG_VAULT_DIR` > `.graphrag/.env` (cwd から walk-up) > `.env` > 規約パス `.graphrag/vault` (cwd から walk-up)**。**`.graphrag/vault` に置けば env も `.env` も要らず素で `ask` が通る**。**vault が外部リポジトリにある場合は `.graphrag/.env` に `GRAPHRAG_VAULT_DIR=<絶対パス>` を書く**のが最も安定する。どれでも見つからなければ大声で停止する。
- OpenAI 互換 embedding endpoint。設定が無ければ Ollama (`http://localhost:11434/v1`) と LM Studio (`http://localhost:1234/v1`) を自動検出。モデルは `nomic-embed-text` に pin。到達不能なら**明示エラー停止**。
- **launcher は起動時に `.env` を 1 回読む**。全 verb が同じ env を見るので verb ごとの不一致は起きない。
- **出力先 env** (§概要の vault 解決で足りない時):
  - `GRAPHRAG_VAULT_DIR` = vault 正本パス。
  - `GRAPHRAG_VAULT_MODE` = `readonly` | `direct` | `worktree` (vault が外部リポにある場合の書き込みポリシー)。**未設定で vault が外部の場合、CLI は書き込みをエラー停止させ LLM にユーザー確認を強制する**。
  - `GRAPHRAG_GRAPH_JSON_PATH` = graph.json 入出力パス。`index` / `carve` / `vault-build` / `vault-import` 時のみ必要。

## focus 継続と read-only triage

- 文脈継続の単位は session ではなく focus / 進行中の調査 (Investigation)。同一 session でも focus が切り替われば新しい focus。
- resume / active-focus 確認 / next-action 抽出は read-only triage。triage の中でグラフ更新・vector index 更新・調査クリーンアップを始めない。
- triage は完了条件ではない。ユーザーが状態確認だけを求めた場合を除き、陳腐化した blockers や完了済み next_actions を stale 候補として報告し、本タスクへ進む。

## retrieval ladder と `ask` の打ち切り判定

要求に答える最小ステップから始め、ソースを開く前にこの順で登る。

1. resume / active focus: `$CLI brief --mode resume` (read-only triage)
2. **典型**: `$CLI ask "<質問>"` — brief→evidence の自動段上げ + `--call-number` 自動加算 (LLM 手動付与不要)
3. 細かく制御したい時 (neighbors を変える等) は primitive (`search` / `evidence`) を直接叩く

GraphRAG が出したファイルを先に読み、`ask` 結果が不足する時だけ広げる。グラフ由来の事実と推論を混ぜない。欠けた知識は一時的な調査ギャップで、新規永続ノードではない。

### 問い方の規律 (一般語+ドメイン語の両建て、`--gist`)

検索は lexical+semantic 合算 (§不可分原則#3) なので、**問いの語彙が当たり面を決める**。

- **一般語とドメイン語を両方入れる**。知識は日本語の一般語 (例「重複検出」) で蒸留されている一方、コードは英語 (例 `duplicate_check`)。片方だけだと当たり面が痩せる。雑な日本語の問いでも、コード語・型名を 1〜2 語添えると両方が効く (例: `ask "重複ノードを弾く duplicate_check の仕組み"`)。
- **`--gist "<想定答えの一行>"` で multi-query にする**。質問文だけでは引きにくい時、期待する答えの一行を `--gist` に添えると、質問と gist を別々に埋め込んで両方で照合する。
  - 例: `ask "なぜ vault を単一正本にした" --gist "graph.json は索引器の中間表現であって正本ではない"`
- **`--graph-rerank on|off`** (既定 off。hub 偏重で net-negative、島構造が均衡したグラフでのみ on 検討)。

### aliases の積み方 (知識ノードに別名を持たせる)

知識ノードの `aliases: string[]` は embedding と lexical の **aliasExact** (別名の完全一致) に配線済みで、**aliasExact は最も強い lexical 一致**として効く。引かれやすさを上げたいノードには、別名を `--aliases "a,b,c"` (カンマ区切り、typed-add 全 verb で指定可) で積む。日本語の一般語と英語のコード語の両方を入れる。

### 打ち切り判定 (ask 出力の読み方)

- `evidence` まで段上げして空なら本当に無い。**別キーワードを 1 度だけ試す**。連打しない。
- `repeat_state: excessive` (call_number ≥ 3) → **グラフ検索を打ち切り、コード / doc 直読みに移る**。
- match の `state_note` (例 `"superseded — refines 逆引きで後継を確認"`) → 注記に従い後継/現役ノードを優先する。
- 各フィールドの詳細は `$REF/ask-output-guide.md`。

## 典型 Recipe

| やりたい事 | コマンド |
|---|---|
| 雑な問いに網羅的に答える | `$CLI ask "<質問>"` |
| 単一 Decision を永続化 | `$CLI add-decision --system <s> --slug <slug> --title "..." --summary "..." --evidence file:<s>:<path>` |
| 失敗した試みを記録 | `$CLI add-rejected-option --system <s> --slug <slug> --title "<試した案>" --summary "<失敗モード>" --rejected-in-favor-of decision:<s>:<chosen>` |
| 運用ハマりを記録 | `$CLI add-ok --system <s> --slug <slug> --title "..." --summary "..." --evidence file:<s>:<path>` |
| 将来踏みそうなリスクを記録 | `$CLI add-risk --system <s> --slug <slug> --title "..." --summary "..." --evidence file:<s>:<path>` |
| 調査エピソードを記録 | `$CLI add-investigation --system <s> --slug <slug> --title "..." --summary "..." --raw-content "代表コミット:\n- 2026-MM-DD <hash> <subject>"` |
| 制約 (不変条件) を記録 | `$CLI add-constraint --system <s> --slug <slug> --title "..." --summary "..." --constrains <id,...>` (`--constrains` 必須 ≥1、宛先 Decision\|File\|OK) |
| 目的・到達点を記録 | `$CLI add-goal --system <s> --slug <slug> --title "..." --summary "..." [--refines <goal-id>] [--state planned\|active\|achieved\|abandoned]` |
| 複雑な plan を確定 (vault に検証適用) | `$CLI commit-mutation <plan.json>` |
| 初回索引 + 概念候補抽出 + 品質ゲート | `$CLI carve --root <repo> --system <name>` (詳細は `$REF/indexing-and-carving.md`) |
| 状態確認 (env / artifacts) | `$CLI inspect` |

`add-*` の `--evidence` は schema 上必須 (Decision/RejectedOption/Risk/OK は source backing が無いと validation reject)。最低 1 つの `file:<system>:<path>` を渡す。**例外**: `add-constraint` は evidence 不要で `--constrains <id,...>` (宛先 Decision|File|OK) を必須 ≥1 で取る。`add-goal` も evidence 不要。

全 typed-add verb はエッジをフラグで張れる。主なもの:

- `add-decision`: `[--sets-policy-for <id,...>]` / `[--premise <id,...>]` / `[--from-investigation <id>]` (led_to) / `[--refines <decision-id>]` / `[--reduces-risk <risk-id,...>]`
- `add-ok`: `[--premise <id,...>]` / `[--refines <id>]` / `[--reduces-risk <id,...>]`
- `add-risk`: `[--risks-in <id,...>]`
- `add-constraint`: `--constrains <id,...>` (必須 ≥1)
- `add-goal`: `[--refines <goal-id>]` / `[--derived-from <id>]` / `[--state planned|active|achieved|abandoned]`
- 全 verb: `[--aliases "a,b,c"]` / `[--description "..."]` / `[--dup-ack <id[,id...]>]`

## Headline verbs (連鎖、1 コマンドで複数段)

- `ask "<q>"` — brief→search→evidence の自動段上げ + `--call-number` 自動加算 (vault を読む)
- `carve --root <repo> --system <name>` — index → vein-hint → policy-suggest → carving-check 連鎖。**索引直後は File 要約も Pocket/Stratum candidate 要約も機械テンプレ (`summary_provisional`)。必ず読んで意味の要約に書き換え `summary_provisional` を外す** (残すと vein-hint 拒否・carving-check ERROR)。**Vein の発見は LLM の概念的モデリングが主役** — vein-hint の機械候補は盲点チェック用 (`$REF/conceptual-pass.md` §2)。
- `commit-mutation <plan.json>` — **vault writer 経由** (lock → OCC → vault import → normalize/validate → 原子 delta 書込 → vector-index 更新 (非致命) → git commit)。失敗は all-or-nothing ロールバック。
- `add-decision` / `add-ok` / `add-risk` / `add-investigation` / `add-rejected-option` / `add-constraint` / `add-goal` — 引数だけで plan 組み立て + **vault に** apply。重複ゲートの suspect を通す時は `--dup-ack <id[,id...]>`。
- `inspect` — env + artifacts (vault / graph.json / vector-index / world) の状態確認 (1 JSON)

## Primitive verbs (段別、細粒度制御)

Headline = multi-stage sugar (即答/典型向き)。Primitive = 各段を直接叩く細粒度制御。優劣なし、制御粒度で選ぶ。詳細 flag は `$REF/cli-primitives.md`。

| verb | 役割 |
|---|---|
| `brief` | 概要応答 (resume / query mode、vault を読む) |
| `search` | ランク済み近傍展開 (vault を読む) |
| `evidence` | 出所付き answer packet (vault を読む) |
| `index` | 決定論索引 (git ls-files + role 分類 + 依存) → graph.json |
| `vector-index` | vector index 構築 (vault から) |
| `vault-build` | graph.json → vault (索引器出力を vault 化する時のみ) |
| `vault-import` | vault → graph.json (round-trip 検証用) |
| `vein-hint` | Vein の機械ヒント (embedding 近接クラスタリング)。LLM のモデリング後の盲点チェック用 |
| `edge-suggest-policy` | sets_policy_for 候補抽出 |
| `carving-check` | carving 品質ゲート |
| `branch-merge` | vault git ブランチの意味的 merge 分析 (読み取り専用)。手順は `$REF/branch-merge.md` |
| `world-refresh` | cross-vault 用 world-cache 再構築。`GRAPHRAG_WORLD_DIR` 設定時 `ask` が `world_hints` を添える |
| `carving-allow` | `.graphrag/carving.json` (carving 免除設定) の管理: `add` / `remove` / `list` / `migrate` |
| `harvest-history` | git 履歴から決定論抽出 (書き込みなし): revert → RejectedOption candidate、HACK/FIXME マーカー → OK/Risk candidate |
| `staleness-check` | 知識ノードの documented_by/sets_policy_for/constrains が指す File のコミット数を数え、閾値以上を candidate 列挙 (読み取り専用) |

## 並行作業の枝分かれと意味的 merge (vault branch)

知識グラフの並行作業は **vault の git ブランチ**で隔離し、merge は git のファイル単位でなく**ノード/エッジ単位で意味を見て**行う (言い換えた重複・系譜の無い Decision を git は取りこぼす)。`branch-merge --branch <ref>` が3状態 (分岐点/枝/main) の差分と衝突を判断パケット (JSON) として返す (読み取り専用)。解決は LLM がパケットを読み、統合後の姿を mutation plan に組んで `commit-mutation` で main の vault に適用する。手順詳細は `$REF/branch-merge.md`。

## スキーマ早見

`graphrag/schema.ts` の `NODE_TYPES`(12) / `EDGE_TYPES`(14) が正本。ノード型・エッジ許容組・ID 規約 (`<typeSlug>:<system>:<slug>`)・state 語彙・方針転換レシピの早見は `$REF/schema-quickref.md`。**判断基準: 選択肢から選んだ → Decision、運用で得た知見 → OK。迷ったら Decision。**

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
- `description` = そのノードを蒸留した散文 (vault body `## 説明` に round-trip marker 付きで出る・embedding にも入る)。**原則どのノードにも書く**。書き分け:
  - **集合系 (Vein 等が特に重要)**: 構成要素の列挙ではなく、**まとまりとして捉えたとき結局それが何なのか (what の正体・意味)**。
  - **判断系 (Decision/Risk/Constraint/RejectedOption/OperationalKnowledge)**: **なぜそう決めたか**。
- `raw_content` = 生の一次情報 (どんな会話をしてどう決まったか・会話ログ・Slack 等の URL)。**判断系でも捨てない**: 後で「なぜ」を辿る一次ソースになる。

`commit-mutation` (および typed-add) が `validateGraph` 通過を強制する (未知型・未許可組・evidence 不足・id 重複・state 語彙違反を reject)。

| やりたい事 | 推奨手段 |
|---|---|
| Decision/OK/Risk/Investigation/RejectedOption/Goal/Constraint の新規 1 件 | typed-add (`add-*`) — JSON 不要 |
| Vein/Stratum/Pocket 新規・Update・Delete・方針転換 | `commit-mutation <plan.json>` — 雛形: `$REF/mutation-templates.md` |

### 書き込み時重複ゲート (duplicate_check)

vault writer は op:create 時に embedding 重複ゲート (cosine 0.92、同型) を掛ける。suspect を確認済みで通す時は `--dup-ack <id,...>`。ゲートは最後の網であり `ask` での事前確認の代替ではない (§Anti-patterns)。仕組み詳細は `$REF/mutation-templates.md`。

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

外部 vault の書き込みポリシーは `GRAPHRAG_VAULT_MODE` (§セットアップ前提)。未設定なら CLI がエラー停止しユーザー確認を強制する。

### 書き込み出力の suggestions

書き込み後の `suggestions` (binding/relations/led_to/premise_candidates/binding_debt) は全て suggest-only・非致命。判断して確定 or 理由付き見送り。自動ではエッジを張らない。詳細は `$REF/mutation-templates.md` §suggestions。

### 永続しないもの

- session 内でしか使わない一時的な探索メモ
- 数分で戻せる scratch (変数名いじり、lint 通すための一時変更等)
- 「未来時制で述べられていない」その場限りの観察

## Topology Gap Review

不具合発見時に「グラフに構造があれば回避できたか」を自問し、不足する Vein/Pocket+エッジを `commit-mutation` で補う (グラフのトポロジー育成)。詳細は `$REF/topology-gap-review.md`。

## Drift Reconciliation (意図せず気付いた乖離)

現タスクで該当ノードを retrieval 経由で読み、かつ同領域のコードも read した文脈が揃った時のみ成立する。「グラフ記述と現ソースが食い違ってる」と気付いても、書き直しを LLM 判断で勝手にやらない (full investigation していないので誤判定リスクが高く、誤った update/delete は元情報を失う)。構造化フォーマット (`[u]pdate / [d]elete / [s]kip / [i]nvestigate` の4択) でユーザーに提示し、裁定後に `commit-mutation` で書き戻す。提示フォーマット詳細は `$REF/drift-reconciliation.md`。systematic な乖離 audit はこれと別物 — ユーザーから明示的に頼まれた時だけ。

## 報告形 (ユーザー向け)

グラフ変更は自然言語で報告する (変更した知識/繋いだ関係/残した理由/検証状態)。node ID / edge ID / `commit-mutation` の JSON 出力はそのまま渡さず、id は括弧参照に降ろす。報告は「で、何をするのか」まで接続する。

## 参照リンク

- `$REF/cli-primitives.md`: primitive 全 flag リファレンス
- `$REF/mutation-templates.md`: Vein / Stratum / Pocket / Update / Delete / 方針転換 plan 雛形 + suggestions 詳細
- `$REF/schema-quickref.md`: ノード型 (12) / エッジ型 (14) / 許容組 / ID 規約 / state 語彙 / 方針転換レシピ
- `$REF/ask-output-guide.md`: ask 出力フィールド詳細 (match_confidence / repeat_state / world_hints / standout)
- `$REF/topology-gap-review.md`: 不具合発見時のグラフ構造自省プロトコル
- `$REF/branch-merge.md`: vault branch の意味的 merge 手順
- `$REF/drift-reconciliation.md`: drift 提示フォーマット詳細とユーザー裁定後の反映
- `$REF/port-site.md`: 移植時のみ参照 (env / escalation / graphName / 出力先)
- `$REF/indexing-and-carving.md`: **初回索引と概念化パスは必ず参照**
- `$REF/carving-rationale.md`: 12 ノード型 + エッジ文法の中核価値、RejectedOption 一級、地質メタファー
- `$REF/interpretation-guidance.md`: File 解釈 summary の汎用ガイダンス (retrieval 品質の主レバー)
- `$REF/conceptual-pass.md`: 概念解釈パスの手順
- `$REF/carving-rules.md`: carving の品質ガード (連番 slug 禁止 / 網羅性 / 重複検出 / 自動検証コマンド)
- `$REF/indexer-redesign-notes.md`: indexer エッセンス・再設計指針・実力 eval
