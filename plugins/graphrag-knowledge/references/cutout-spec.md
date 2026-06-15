# GraphRAG 知識基盤の SKILL 切り出し仕様

> ⚠️ **歴史記録 (2026-05-18 時点)**。これは gestalty→skill スピンアウト当時の方針確定を残した記録で、
> 当時の「FalkorDB が正本 / 軸2 = Concern・Component・Layer / Requirement 型」を前提に書かれている。
> **v3 で正本は vault に一本化**され、軸2は地質メタファー (Stratum/Vein/Pocket)、Requirement は Goal に吸収された。
> 現行の正は `SKILL.md` / `CLAUDE.md`。本文は当時の判断の「なぜ」を保全するため改変しない。

作成日: 2026-05-18 / 状態: 方針確定(実装未着手)
出自: gestalty からのスピンオフ(gestalty 本体とは無関係の独立プロジェクト)

## 目的とスコープ

gestalty の「エージェントがグラフ DB を中心に知識を溜め込み、網羅的に判断できる」能力を、
既存開発プロジェクトへ持ち込める SKILL(+ 毎回不要な参照資料)として切り出す。

確定したスコープ判断:

- FalkorDB ありき。グラフストア非依存の抽象レイヤは作らない(中難度の山を意図的に削る)。
- semantic は非交渉。品質の落ちた retrieval を一級サポート経路としては設計しない。
- embedding endpoint 欠落・モデル不一致はサイレントに倒さない。
- LLM フレンドリ層は不可分原則。LLM に生 FalkorDB クエリを書かせない。

## LLM フレンドリ層(不可分原則)

非 vector のグラフ読み書きでも、LLM に直接 Cypher / FalkorDB クエリを考えさせない
(トークン浪費と誤りの温床)。LLM が触れる面は次の2つだけに固定する:

- 読み: ランク済み JSON(`brief` / `search` / `evidence` の出力。`searchGraph` /
  `nodeForOutput` が JSON in / JSON out)。
- 書き: mutation プラン JSON(`reason` / `nodes` / `edges`)。これを `mutate-falkordb`
  が検証・適用する。LLM は Cypher を生成しない。

この層を薄くしたり、生クエリ経路を LLM に露出させる変更は本スキルの設計違反とする。
gestalty では既にこの形が成立しており、移植時もこの境界を保存・強化する。

## パッケージ構造(3層)

### 1. SKILL 本体(手順テキスト)

retrieval ladder、focus / 進行中の調査(Investigation)の継続性、mutation workflow、
報告フォーマット、escalation policy を手順として記述する。
escalation / permission policy は移植先の環境依存なので「ここは移植先で書き換える」と明示する。

### 2. 同梱コード(FalkorDB 前提・そのまま動く)

`references/migration-manifest.md` の Tier 分けに従って移植する。

### 3. 参照資料(SKILL から必要時のみ参照)

- carving 根拠: なぜこの12ノード型/このエッジ文法か、RejectedOption を一級にする理由、
  Concern ≠ Component ≠ Layer の切り分け理由。書き起こさないと暗黙に失われ移植先が下手に再導出する。
- 必須インフラ契約: FalkorDB の起動手順 + embedding endpoint 要件。
- 移行/復元手順: vault は git でそのまま運ぶ無損失表現、vector-index は移植先でローカル再生成。

## embedding ポリシー(確定)

- semantic 必須。フォールバック経路(ngram のみ運用)は設計しない。
- 自動検出: 既定で Ollama(:11434 の OpenAI 互換 `/v1`)と LM Studio(:1234 `/v1`)をプローブ。
  設定で endpoint を上書き可能。
- モデル pin: `nomic-embed-text` / 768次元 を正準とする。endpoint の models 一覧で
  当該 embedding モデルの存在を検証する(chat モデルへの誤投げを防ぐ)。
- vector-index に build 時のモデル名と次元を記録し、retrieval 時に突合する。
- 大声で停止: endpoint 欠落 **または** モデル不一致のとき、retrieval コマンドは明示エラーで終了。
  エージェントは「semantic 未接続: Ollama / LM Studio で nomic-embed-text を起動せよ」と
  具体手順を必ず報告し、ごまかして探索を継続しない。
- サイレント失敗禁止の対象は endpoint 欠落だけでなくモデル/次元の不一致まで含む
  (より深い層の静かなランキング破損を防ぐ)。実装場所は `vector.ts`。

## 情報損失と残留リスク(誠実版)

- enforcement は救われた。FalkorDB ありきにしたことで `mutate-falkordb` の出所必須ゲートを
  そのまま同梱でき、当初懸念した「強制 → 助言への格下げ」損失は回避される。良い副作用。
- carving 根拠を参照資料に書き起こさないと暗黙喪失。これは必須タスクであって任意ではない。
- 移植先が貯める中身は運べない。SKILL が渡すのは「能力のある空システム + 規律」であり、
  網羅性は移植先で時間をかけて獲得される。「入れたら即網羅判断」ではない、を期待値として明記する。
- escalation / permission policy は移植先環境依存。要書き換え。
- vector-index は非ポータブル(モデル束縛)。移植先でローカル再生成が運用義務として残る。
- 移植単位は当初の「2ファイル+schema」印象より大きい。シリアライザ単体は独立だが、
  動く skill としては retrieval/mutation コアほぼ全体が移植対象(`migration-manifest.md` 参照)。

## 難易度まとめ

- 低: schema 仕様 / vault 往復 / 手順テキスト同梱。
- 低〜中: embedding 検出 + pin 検証 + 不一致ゲート(`vector.ts`)、`deriveShortLabel` 抽出。
- 消滅: グラフストア抽象化(従来の中難度の山)はスコープ外にしたため発生しない。
- 移植先が負う運用: FalkorDB 起動 + OpenAI 互換 embedding endpoint(Ollama / LM Studio)。

## 進捗

- (済)同梱コードの依存棚卸し → `references/migration-manifest.md`。
- (済)Tier A/B/C 移植 + `labels.ts` 抽出 + 最小 `package.json`。
- (済)embedding 検出 + nomic-embed-text pin + models 検証 + 不一致=欠落(大声)を
  `vector.ts` に実装、build/query 経路へ配線。検証: import 全 green、テスト 10/11 pass。
- (済)`data/graph.json` 依存テストを不在時 skip 化(option B)。テスト 11: 10 pass / 0 fail / 1 skip。
  合成往復テストが常時ゲート。難ケース fixture(option A)は品質投資として後続。
- (済)SKILL 本体ドラフト → `skill/SKILL.md`。不可分原則・retrieval ladder・読み書き契約・
  mutation workflow・embedding 前提・PORT SITE を明記。
- (済)carving 根拠資料 → `references/carving-rationale.md`(型/エッジ文法/RejectedOption 一級/
  Concern≠Component≠Layer/Symbol 非ノード/不変条件)。
- (済)汎用 indexer → `graphrag/index-codebase.ts` + テスト。エッセンス再設計
  (git-ls-files+content_hash freshness / File summary 機械合成 / Concern 候補→LLM 判定)。
  プロジェクト固有ルール非同梱、`validateGraph` 自己検証、増分 change_status・削除検出。
  `node graphrag/cli.ts index` 追加。

## 完成状態と検証

スキルとして読める・実走できる最小完成形に到達。検証済み(オフライン):
ユニットテスト全 green、indexer の実リポジトリ実走 → `validateGraph` 合格 →
vault 往復スモーク(末尾「検証ログ」参照)。

未検証(この環境で不可・移植先で実施): ライブ FalkorDB sync、embedding endpoint 実接続
での retrieval E2E。PORT SITE(escalation / 環境変数名)の実環境合わせ。

## 次の具体ステップ候補(任意・品質投資)

1. 難ケース fixture(option A)で vault 往復ゲートを強化。
2. 移植先で SKILL.md を実走させ PORT SITE を実環境に合わせる。
3. 必要なら Symbol ノード/依存エッジのスキーマ拡張(合意のうえ。現状は意図的非対応)。
