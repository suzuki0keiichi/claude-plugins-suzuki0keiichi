# indexer 再設計ノート(エッセンス + 未成熟点)

> ⚠️ **歴史記録 (2026-05-18 時点) + eval ログ**。本文中の `Concern` / `Component` / `Layer` は
> v3 で地質メタファー (`Vein` / `Pocket` / `Stratum`) に改名された (旧名は alias)。
> 本文中の `System` ノードと `contains` エッジは **v3.3 で撤去済み** (現行 indexer は
> File/Pocket/Stratum ノードと `evidenced_by` のみ生成する)。
> eval は当時 scratch FalkorDB graph で実測したもの (v3 の正本は vault)。
> 設計指針 (足場=決定論 / 解釈=LLM、interpretation-guidance + role 重み) は現行も有効。日付付き実測値は記録として改変しない。

方針: gestalty の indexer 現物を blind copy しない。エッセンスを読み取り、
スキル側で良い形に作り直す。本ノートは gestalty 現物の調査結果(2026-05-18)。

## gestalty 現物の構成と成熟度

| パス | 責務 | 種別 |
|---|---|---|
| `indexer/index-file.ts` | リポジトリ静的スキャン → System + File ノード + `contains` エッジ | 動く(正規表現ベース・軽量) |
| `indexer/concept-candidates.ts` | File グラフ → Concern/Component/Layer 候補 + `evidenced_by` | 動くが規則が agnocast/ROS2 固有 |
| `graphrag/build-vector-index.ts` | ノード embedding(差分対応) | 動く |
| `graphrag/seed-initial-graph.ts` | gestalty 自身の知識を手書きした初期グラフ | 手書き seed(スキャンと無関係) |

## 再利用するエッセンス(3点)

1. **ファイル列挙 + freshness**: `git ls-files`(fallback 再帰 readdir)+ SHA256
   `content_hash` + `git_head` で `change_status: new|changed|unchanged` を付与。
2. **File summary の機械合成 → embedding**: 「役割文 + 主要API + 内部要素 + 依存先 +
   特徴 + 関連テスト + route + 見出し」をテンプレ合成し summary に詰める。
   embedding テキストは `id/type/title/summary/description/path/aliases/tags/display`
   を改行連結(`graphrag/vector.ts` `nodeVectorText`)。**summary 品質 = embedding 品質**。
3. **Concern の判定分離**: 規則スコアリングで候補化し、`judgment_input`(concern 定義・
   evidence_files・entry_files・split_routes・`expected_output_schema`)を同梱して
   最終判定を LLM に委ねる。決め打ちで確定させない。

## 作り直す領域(未成熟・欠落)

- **AST 不在**: シンボル/import が全部正規表現。Go・Rust・Java・Ruby 等は抽出ゼロ、
  拡張子マップ外はスキャン対象外。任意リポジトリ対応にはここが要。
- **Symbol ノード/依存エッジが無い**: シンボルは File の配列フィールドどまり。
  Symbol 型・call/参照エッジ・File→File 依存エッジは schema にも無い。
- **要約が機械合成のみ**: 意味的記述が無く、agnocast 用 trait が任意プロジェクトで
  空になり summary が痩せて embedding 品質が落ちる。
- **Concern/Layer が決め打ち**: ルールが agnocast/ROS2 固有。File→Concern/Component/Layer
  の汎用マッピングが無い。
- **増分再インデックス未実装**: content_hash 差分は出すが unchanged skip 経路が無く
  毎回フル再生成(embedding 側のみ差分対応)。
- **doc→知識候補が無い**: README 方針に反し未実装。md は見出しを alias に入れるだけ。
  知識ノード化は seed で手書きされているのが現状。

## 再設計の指針(本スキル側)

- 任意リポジトリ前提。言語追加を AST/LSP ベースに寄せ、正規表現は劣化フォールバック。
- summary は「機械合成 + 任意で LLM 補強」の二段。embedding 品質要件を満たすこと。
- Concern/Component/Layer は汎用シグナル(ディレクトリ構造・依存集約・命名)で候補化し、
  最終確定は LLM フレンドリ層(`judgment_input` 同梱)に流す。決め打ちルールを同梱しない。
- 増分: content_hash で unchanged を skip し、変更ノードだけ再生成 + embedding 差分更新。
- LLM フレンドリ層の不可分原則(生クエリを LLM に出さない)を indexer 出力経路でも守る。

## 実測(2026-05-18, yasashiisek.ai 201ファイル TS/React)

新 indexer を yasashiisek.ai に実走 → scratch FalkorDB graph(gestalty 正本不可触・
事後削除)→ 生 nomic-embed-text で vector index → 既知正解クエリで命中採点。

結果: **自動生成 summary は自然言語(日本語)クエリに対し retrieval-grade ではない**。
5クエリ中、期待ソースファイルが top3 に入ったのは1件のみ(しかも #3)。CLAUDE.md /
AGENTS.md / references/**.md(日本語自然文を持つ)が一貫してソースを押しのけた。

診断: 機構は健全(該当ソースは別クエリで #2 に出る等)。原因は File summary が
「X は ソース(typescript)。主要API: createPasskey…」という**役割語 + 英語識別子列**
で、**何をするかの自然言語記述が無い**こと。日本語クエリとのベクトル距離が遠く、
日本語見出しを持つ docs に負ける。上記「要約が機械合成のみ→embedding 品質低下」が
実測で深刻と確認された。Tier-2(gestalty 純正一致)は人手 curate 済み summary に
乗っていただけで、自動 summary の retrieval 品質は別問題だった。

確定した次の必須改修(設計指針の二段目を実装する):

1. File summary に**自然言語の責務文**を1文加える(LLM 補強 stage-2。識別子列だけに
   しない)。これが embedding を NL クエリ近傍へ寄せる主レバー。
2. 必要なら doc/meta ノードの検索重みを下げる、または lane 分離を検討。
3. 上記改修後、同じ eval(index → scratch sync → vec → 既知正解クエリ)を再走して
   命中率で判定。この eval 手順自体を再現可能な回帰ゲートとして残す。

## 再評価(2026-05-18, 正しい前提 = 解釈は Opus が行う)

前回は regex 生成 summary を「解釈」の代わりに置いた不公平な測定だった。正しい前提
(ソース→グラフの解釈はコードでなく Opus/Sonnet が担う)で再測定。Opus サブエージェント
5体並列で yasashiisek.ai 全200ファイルの実ソースを読ませ、自然言語の責務 summary を
生成(eval クエリは伏せた)。indexer 足場・embedding・5クエリは前回と同一。

| クエリ | BEFORE(regex) | AFTER(Opus 解釈) |
|---|---|---|
| パスキーでログイン検証 | 外し | #1 auth/passkey.ts |
| 投稿1日上限とスレッド作成 | 外し | #1 services/post-service.ts |
| OpenAI でモデレーション | #3 | #1 moderation.ts |
| メール認証トークン | 外し | #2 email/verify・#3 auth/email.ts |
| コミュニティのサポーター判定 | 外し | #2 community-supporter.ts |

**top3 命中 1/5 → 5/5(厳密 #1 が 3/5)**。残り2件も正解が top3、#1 は意味的に妥当な
隣接(認証ドメイン / 実際にサポーター指定を行う admin UI)。validateGraph 0、解釈
summary 平均196字。scratch 事後削除・gestalty 461 不変。

確定した結論:
- 「実力の天井」はアーキテクチャでもモデル知能でもなく、**regex を解釈の代わりに
  置いたこと**だった。indexer=決定論足場 / Opus=ソース→グラフ解釈 の分担で retrieval は
  破綻から実用へ跳ねる。設計判断(解釈は skill 実行 LLM が担う)が実測で裏付けられた。
- よって「次の必須改修」の(1)は撤回 ── indexer コードに LLM stage-2 を足さない。
  正しい実装は SKILL.md に「changed File を Opus が解釈し責務 summary を書き、mutation
  経由で書き戻す」手順を持たせること。eval(この5クエリ)は回帰ゲートとして固定。

## 改善ループ → 厳密 #1 で 5/5 収束(2026-05-18)

目標「厳密 top-1 で 5/5」。チート禁止(正解誘導/リポ特化/特定ファイル手編集の禁止)。
解釈担当には常に5クエリを伏せ、ガイダンスはリポ/クエリ固有語ゼロの汎用のみ、
gestalty 正本不可触(毎回 461 不変)、scratch 都度削除。

収束過程(厳密 #1): 1/5 → 3/5 → 4/5 → **5/5**。効いた**汎用**変更:

1. `references/interpretation-guidance.md`(汎用): 種別タグ→識別機能→behavior / 集約・
   定数・広域 doc は列挙禁止 / UIとロジック分離 / 自ファイルとパスの全概念語を
   一般語で必ず含める(欠落禁止)。特定解の語は一切含まない。
2. `graphrag/retrieval.ts` `DEFAULT_ROLE_WEIGHTS`: 役割考慮ランキング(source 1.0、
   api_route/ui 0.85、config 0.62、test 0.55、doc 0.6)。GraphRAG 本来のグラフ信号
   活用。生 top-1 cosine はスキル最弱の使い方だった、という診断の帰結。
3. `graphrag/index-codebase.ts` `roleFor`: 定数/設定/型 barrel と dotfile/`.env`/
   `.example` を `config` に正しく分類(従来 `source` 誤分類で実装を押しのけていた)。

最終(raw top-1、LLM 判定 ladder 不要):

| クエリ | #1 |
|---|---|
| パスキーでログイン検証 | src/lib/auth/passkey.ts ✅ |
| 投稿1日上限とスレッド作成 | src/lib/services/post-service.ts ✅ |
| OpenAI でモデレーション | src/lib/moderation.ts ✅ |
| メール認証トークン生成と検証 | src/lib/auth/email.ts ✅ |
| コミュニティのサポーター判定 | src/lib/community-supporter.ts ✅ |

= **5/5 厳密 #1**。整合性検査: guidance.md にリポ/クエリ固有語ゼロ、コード変更は
一般則のみ(特定ファイル/解答非依存)、ユニットテスト 12 pass/0 fail で回帰なし。
天井はモデルでなく「導き方(解釈ガイダンス)+ グラフ信号(role)の活用不足」だった、
というユーザー予想の最終確認。回帰ゲート: 上記5クエリで厳密 top-1 を維持すること。
