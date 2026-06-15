# 概念解釈パス — スキーマ合法マッピング(汎用)

indexer の決定論足場の上に、LLM が概念・アーキ・履歴を乗せる手順の正確版。
任意リポジトリに通用。新エッジ/ノード型は足さない。全プランは `validateGraph`
0 失敗を確認してからマージ。root ノードや contains は不要 (v3.3 で撤去。
scope は vault 境界が、所属は id 規約 `<typeSlug>:<system>:<slug>` が担う)。

**本ファイルは「手順」**。Pocket / Vein / Stratum (地質メタファー、旧 Component / Concern / Layer) の
**切り方・粒度・命名・網羅性・増分追従の品質ルール**は `carving-rules.md` に分離。本ファイルの各 step は
carving-rules.md の該当節を必ず満たすこと。手順だけ追って carving-rules を満たさない mutation は不良。

## 0. 大原則 — 「意味」を書く(「構成要素のサマリ」は意味ではない)

すべての蒸留テキスト(File / node の summary・description、Pocket / Stratum / Vein の命名)に通底する唯一の規則。各 step はこれを満たす。

- **構成要素のサマリ** = 中身の部品を機械的に言い換えたもの。File なら symbols / imports、Pocket / Stratum / Vein なら束ねた File 群の列挙。「何が入っているか」。
- **意味** = なぜ在るか / 何のため / どの関心・責務を担うか。「何のためか」。
- **書くのは必ず意味。** 構成要素の列挙・言い換えで埋めない(= サボり)。薄い結節点でも、それ自体の意味(なぜ束ねたか)を書く。
- **description は任意。** 書くなら意味(その集合・横断が何を意味するか)を書く。意味として書くことが無いなら**空にする**(構成要素の羅列で埋めない)。summary と内容が近くても、意味が書いてあれば問題ない ── **等価判定はしない**。
- **機械が出した構成要素サマリ**(File summary / Pocket・Stratum candidate summary)は `summary_provisional: true` が立つ。意味に書き換えて `summary_provisional` を外す。残すと carving-check が `summary-provisional` ERROR で止める。
- 書いた内容が意味か構成要素サマリかの判定は、**書くのと同じ LLM の責務**(別の機械チェックは置かない ── 同じ LLM による事後判定は循環で無意味だから)。よってこの規則を**書く時点で**守る。

## 入力(indexer / 環境が用意)

- 依存コミュニティ Pocket 候補・トポロジ Stratum 候補(`judgment_input.member_files`)。
- 全 File の `{path, role, summary}`(summary は `interpretation-guidance.md` 準拠の解釈済み)。
- `role=documentation` の doc File 一覧(+ 必要なら本文を読む)。
- `git log`(hash・date・subject、時系列)。

## 1. Pocket / Stratum 命名(グラフ距離が単位、LLM は命名)

- 既存候補ノードの `title`/`summary` を**意味**(その機能境界 / アーキ層が何を担うか。§0)に更新、`summary_provisional` を外す、`candidate:false`、`judgment_input` 削除。candidate summary は構成要素サマリ(束ねた File 群の機械テンプレ)なので、列挙の言い換えで埋め直さない。
- **機械プレースホルダ命名を引き継がない。** indexer は候補に `title="Stratum band 0/3 (41 files)"` /
  `"Pocket candidate c1"`、`id` に `band0` / `c1` を付ける。これは依存深さ帯・連番・ファイル数=構成要素で
  あって意味ではない。**必ず**「その層/塊が何を担うか」の意味 title + 意味 kebab slug に置き換える
  (例 `基盤層 — 設定・データの土台` / `stratum:<sys>:foundation`)。band 番号・`(N files)`・`cN` を
  title や slug に残したまま確定しない(= 「カスみたいな命名」。`carving-rules.md`「意味ある命名 必須」)。
- 無意味クラスタは accept=false で却下(ノードと付随エッジを除去)。
- 構造は変えない(メンバーは依存グラフが決める)。
- 命名・粒度・異物検査・意味 slug・Stratum 除外規則は `carving-rules.md` の
  「意味ある命名 必須」「Pocket carving」「Stratum carving」を厳守(項目: 意味 title/slug・プレースホルダ
  禁止 / 同ディレクトリ原則 / 粒度ガード / Stratum は実行依存対象のみ / テストは実装と同じ Stratum)。判断基準と
  閾値は carving-rules.md を正本とし、本ファイルでは再掲しない。
- carve 完了の判定は機械ゲートで強制: `carving-check` の `candidate-uncarved` / `placeholder-title` /
  `summary-provisional` が **0 ERROR** になって初めて carve 完了(プレースホルダのまま確定すると止まる)。

## 2. Vein(横断・概念グルーピング、鉱脈)

- 新規 `Vein` ノード `vein:<sys>:<slug>`。
- `Vein -evidenced_by-> File`(evidenced_by: crosscut→File 合法)。
- モジュール境界=Pocket とは別。層や塊を貫いて横断するものだけ。
- 詳細な切り分けルールは `carving-rules.md` の「Vein carving」を厳守(項目:
  横断条件 ≧2 Pocket / 1 Vein = 1 動機 / Pocket との二重表現禁止)。判断基準と
  閾値は carving-rules.md を正本とし、本ファイルでは再掲しない。

## 3. ドキュメント蒸留

- 許可ノード: `Decision` / `Risk` / `OperationalKnowledge` / `Vein`。
- 出所リンク(これだけが合法):
  - `Decision|Risk|OperationalKnowledge -documented_by-> File(出所doc)`。
  - `Vein -evidenced_by-> File(出所doc)`。
- `Constraint` は `documented_by` 不可。使うなら `Constraint -constrains->
  File|Decision|OperationalKnowledge`。基本は Decision/OK に寄せる。
- `Decision -derived_from-> ConversationChunk|Investigation` も可(履歴と接続時)。

## 4. git 履歴 → 知識

- ノード: `ConversationChunk`(開発エピソード)/`Investigation`/`Decision`。
- 合法エッジのみ:
  - `ConversationChunk -discussed_in-> Investigation`
  - `Investigation -led_to-> Decision`
  - `Decision -derived_from-> ConversationChunk|Investigation`
- ~12–25 ノードに束ねる(132 コミットを全ノード化しない)。撤退/移行/長期格闘も残す。

## 5. 知識軸シーディング(carve 完了後・初回に必ず)

carve(軸2: Pocket / Vein / Stratum)が完了しても、知識軸(Goal / Constraint / Decision /
RejectedOption / Risk / OperationalKnowledge)が空のままでは **design-review の scope-creep /
roadmap 観点が無効**になる(照合先の Goal が無ければ「目的から外れていないか」を問えない)。
この状態は `carving-check` の `knowledge-floor` 規則が WARN `knowledge-floor-goal-missing` で
可視化する(Constraint 0 件も同形 WARN)。carve 完了後、下記 5a / 5b で知識軸の床を起こす。

### 5a. ユーザーインタビュー → Goal ツリー + 主要 Constraint

ユーザーへの短いインタビューで起こす。**Goal / Constraint / RejectedOption はいずれも typed-add
(`add-goal` / `add-constraint` / `add-rejected-option`)で足りる**(commit-mutation 雛形は複雑ケース用)。
問いは 3 つで足りる:

1. **このシステムの到達点は何か** → `Goal` ツリー。最上位 Goal 1 個に下位 Goal を
   `refines`(Goal → Goal)でぶら下げ、計 **3〜7 個**。粒度はロードマップで語れる単位
   (機能名の羅列にしない。§0 大原則 — 構成要素でなく意味)。state 語彙は
   `"planned" | "active" | "achieved" | "abandoned"`(state 無しも合法)。
   - `node graphrag/cli.ts add-goal --system <s> --slug <slug> --title "..." --summary "..."`
     `[--refines <goal-id>]`(上位 Goal にぶら下げる)`[--state planned|active|achieved|abandoned]`
     `[--derived-from <conversation/investigation-id>]`(出所会話/調査に接地する時)。
     最上位 Goal は `--refines` 無しで作り、下位 Goal を `--refines <最上位 id>` でぶら下げる。
2. **絶対に守る制約は何か** → 主要 `Constraint`。`constrains` で対象
   (Decision|File|OperationalKnowledge)に張る。横断高度の constrains は文法に無いので、
   高度が無い場合は File 列挙 + 範囲を summary に明記する(`carving-rules.md`
   「Constraint の Decision ロンダリング禁止」)。
   - `node graphrag/cli.ts add-constraint --system <s> --slug <slug> --title "..." --summary "..."`
     `--constrains <id,...>`(**必須 ≥1**、宛先 Decision|File|OK)。Constraint は
     documented_by 不可・evidence 不要なので `--evidence` は取らない。
3. **過去に試して捨てた案は何か** → `RejectedOption`(却下案一級)。再誘惑されうるものを優先。
   `add-rejected-option`(出所必須)。

いずれも `--aliases "<日本語一般語>,<英語コード語>"` で別名を積んでおくと後で雑な問いから引きやすい
(aliasExact が最強の lexical 一致。SKILL.md §retrieval ladder)。

### 5b. harvest-history の candidate を種にする(初回索引時の知識収穫)

`harvest-history --root <repo> [--system <name>] [--out <path>]` は git 履歴から
**決定論抽出のみ・書き込みなし**で candidate JSON を出す(concern-suggest と同じ思想。
採否は LLM が判断して typed-add する前提):

- **revert コミット** → `RejectedOption` candidate(`suggested_slug` / `title` / `commits` /
  `note`)。「一度入れて戻した」は再誘惑される筆頭。中身を見て、却下案として残す価値が
  あるか**個別判断**する(機械的に全件ノード化しない)。
- **コメントマーカー** HACK / FIXME / WORKAROUND / XXX → `OperationalKnowledge` / `Risk`
  candidate(`path` / `line` / `marker` / `text`)。恒常的な運用知識・リスクに昇格する
  価値があるものだけ拾う(一時 TODO の写経にしない)。

採用した candidate は typed-add(`add-*`)で書く。出所必須(`documented_by` /
`derived_from`)と書き込み時の duplicate_check は通常どおり効く — 既出と疑われたら
既存ノードへの追記・統合を先に検討する。

## マージと検証

1. 各プラン JSON を base グラフへ適用(id 重複は skip、エッジ id は決定論生成)。
2. `validateGraph` 実行。失敗エッジ(型ペア不正・端点欠落)は drop、再検証で 0 に。
3. **carving 品質ゲート**(`carving-rules.md` の「carving 提出前チェックリスト」)を通す。
   特に網羅性ゲート: `src/` 配下 File が allowed-orphan を除き全て Pocket に所属、
   `src/` + `packaging/` 配下 File が除外規則該当を除き全て Stratum に所属していること。
   未所属 File が残るなら mutation plan の `reason` に allowed-orphan として明記する。
4. `commit-mutation <plan.json>` で vault に適用(vault writer が validate → 原子書込 → vector-index 更新 → git commit をまとめて行う)。
5. 回帰: 既知正解クエリで top-1、無コンテキストエージェントで影響波及が辿れること。

## 増分 conceptual-pass(changed / new File への対応)

`node graphrag/cli.ts index` の `change_status: new|changed|unchanged` に従う。詳細は
`carving-rules.md` の「増分追従」節。要点:

- `unchanged`: conceptual-pass 不要。
- `changed`: File summary を `interpretation-guidance.md` 準拠で再生成。所属関係は維持。
- `new`: **必ず carving 再評価**。既存 Pocket に同ディレクトリ原則で吸収できるか確認、
  できなければ新 Pocket を carving。新規ディレクトリが出現したら新 Pocket 必須。

## エッジ型ペア早見(`graphrag/schema.ts` が正)

- `evidenced_by`: Stratum|Vein|Pocket → File
- `documented_by`: Decision|RejectedOption|Risk|OperationalKnowledge|Investigation → File
- `derived_from`: Decision|RejectedOption|Risk|OperationalKnowledge|Goal → ConversationChunk|Investigation
- `discussed_in`: ConversationChunk → Investigation
- `led_to`: Investigation → Decision
- `constrains`: Constraint → Decision|File|OperationalKnowledge
- `has_premise`: Decision|OperationalKnowledge|Investigation → Decision|OperationalKnowledge|Constraint|Risk|Goal
- `refines`: Decision|OperationalKnowledge → Decision|OperationalKnowledge / Goal → Goal
