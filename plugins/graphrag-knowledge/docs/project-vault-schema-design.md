# Project Vault Schema Design — 引き継ぎ書

> この文書は 2026-06-18 のスキーマ設計議論をそのまま引き継ぐためのもの。
> サマリではなく、議論の流れ・思考の厚み・未決事項をすべて含む。
> 次のセッションはこれを読んで「途中参加した同僚」として議論に入ること。

---

## 1. 背景と目的

### system vault で達成したこと
AIが初見で問題を解くアンフェアなスタイルをやめ、ベテランのような知見を必要な時に漏れなく引けるようにした。vault (Obsidian Markdown) を単一正本として、採用判断/却下案/制約/目的/リスク/運用知識/横断関心/File を安全に読み書きする。

### project vault で目指すこと
人間のプロマネがやる当たり前のこと（進捗確認・適切な報連相・ボトルネックや予算オーバーの特定など）をこなしつつ、**人間では無理だったレベルの答えを出す**。

人間は無限の体力がないので、プロジェクトの大きな流れからの漏れや矛盾、危険な兆候やチャンスをすべてチェックし続けることは出来ない。AIならできる。具体的に:

- 過去事例から、プロジェクトの計画で何が漏れているかを導き出す
- お金に関して「こう工夫すればあれが実現できるのに」を提案する
- 工数の最適化、リソース配分の cross-project 最適化
- 全ての前提条件・仮説を常時監視し、崩れたら即座に影響範囲を特定

### system vault との本質的な違い
- system vault = **受動的** (聞かれたら答える)
- project vault = **能動的** (定期的に自分からチェックして問題を見つける)

ユーザーのチェックリスト（後述）の大半が「〜しているか」という継続的監視であることがその証拠。

---

## 2. 議論で確立した設計原則

### 2.1 vault 境界を跨ぐ必要性
project vault は system vault よりも vault 境界を跨げる必要がある。調整余地も変動要素も複数のプロジェクトをまたいで考えないともったいなさすぎる。

具体例:
- プロジェクト A のリソースが逼迫 → B で余っている同スキルの人を一時的に
- プロジェクト A で学んだ教訓 → C の計画にそのパターンが出てる
- 複数プロジェクト共通の外部依存 (API 値上げ、法改正) → 横串で影響を見る

system vault の `world_hints` はおまけ程度だったが、project vault では **cross-vault query が一級機能** になる。

### 2.2 情報ソースの扱い
system vault の File に相当するものとして **Source** を置く。議事録URL、Slackスレッド、Confluenceページ、スプレッドシート等。File と違い git が鮮度を担保しないので、Source ノードは鮮度の自己管理が必要:
- `url`: 原典の場所
- `fetched_at`: 最後に内容を確認した日時
- `refresh_method`: どうやって最新情報を取るか
- `staleness_threshold`: どのくらいで stale とみなすか

外部情報で定期的に更新するものはデータの引き直し方もちゃんと憶えさせる。

### 2.3 不確実性の可視化
ノード（特に Assumption）に certainty level を持たせる:
- **Established**: 確定している事実 (契約済み、合意済み、実績あり)
- **Expected**: 高い確度で見込める (過去パターンから、関係者の口約束)
- **Assumed**: 仮定している (検証していない、状況から推測)
- **Speculative**: 推測・希望 (やってみないとわからない)

これにより:
- 「Speculative な前提に依存している Decision が 3 つある」→ リスク可視化
- 「この前提は 2 ヶ月前に Assumed だったが、検証されて Established になった」→ 進捗の一形態

### 2.4 事業計画との相性
事業計画は「仮定のツリー」であり、graph の一番おいしい使い方の一つ。

```
売上 = ユーザー数 × ARPU × 継続率
         ↑           ↑        ↑
      Assumption   Assumption  Assumption
      (月1000人獲得)  (¥2000/月)  (80%/月)
```

graph がやるのは数値計算ではなく、計算の前提構造の管理。スプレッドシートが「what」を計算し、graph が「why と if」を追跡する。この分業で「売上予測が外れた時に、どの仮定が間違っていたか」を即座に特定できる。

実際の計算モデルは Source ノードとして参照し、graph には仮定の構造だけ入れる。

### 2.5 横断関心の扱い — Theme
system vault の Vein/Stratum/Pocket は「コードがファイルに断片化されている」から必要だった。project vault ではノード間のエッジで大半が足りるので、同じ問題は起きにくい。

ただし **複数プロジェクトを横串で貫く関心** は明示しないと見えない:
- 「コスト削減」「GDPR 対応」「来期の組織再編」「技術負債返済」等

これが **Theme** として Vein の位置に入る。単一プロジェクト内では不要（エッジで足りる）、複数プロジェクトになった時に横串の武器になる。

### 2.6 Vein/Stratum/Pocket の命名後悔
もともと汎用概念にしたくて地質メタファーに言い換えたが、vault ごとにスキーマが分かれた時点で、system vault は素直に Layer/Concern/Component でよかった。（注: v1.3.0 で既に Layer/Concern/Component に戻している）project vault は独自の横断概念 (Theme) を持つので、命名の汎用化は結局不要だった。

---

## 3. ノード型の設計過程

### 3.1 Lesson と Contingency の吸収
当初 Lesson と Contingency を独立ノード型として提案したが、ユーザーの指摘で吸収:

**Lesson → OperationalKnowledge に吸収**: Lesson の本質は「状況 X で Y すると Z が起きる」という因果パターン。これは OK そのもので、出自の違いは `derived_from → Source (ポストモーテムURL)` のエッジで表現すれば十分。

**Contingency → PlanB をエッジで表現**: ユーザー発案。PlanB は普通の Task/Goal であって特別な型じゃない。「もし A が駄目なら B」の情報はエッジ (`falls_back_to`) にだけ存在する。粒度も自由（Goal 単位でも Task 単位でも）、連鎖も可能 (A→B→C)。

### 3.2 Task の追加
Goal と Milestone の間に「具体的に何をやるか」を表すノードがなかった:
- Goal = 「何を達成したいか」(目的)
- Milestone = 「いつまでに到達するか」(時間軸のチェックポイント)
- Task = 「具体的に何をやるか」(作業の塊)

Jira/Linear レベルの個別チケットは入れない。graph に入れるのは **判断に関わる粒度の作業** — 依存関係がある、リスクがある、リソース配分の対象になる、順序が重要、等。

### 3.3 Resource の位置づけ
リソース (ヒト・モノ・カネ) は Constraint に押し込む誘惑があるが、「同じ人が 3 つのプロジェクトに配分されている」のような共有と競合を表現するために first-class ノードにした。

Stakeholder との関係:
- **Stakeholder** = 「この人/組織は結果に関心がある」(利害関係者としての顔)
- **Resource** = 「この人/予算/設備は消費・配分される」(リソースとしての顔)

同じ人間が両方の顔を持つ。別ノードにする理由は cross-vault 時に片方だけ引きたい場面が多いから。

### 3.4 Agreement と Constraint の分離
ユーザー確認済み。Constraint は「自分たちの制約」、Agreement は「相手との約束」で方向が違う。異論なし。

---

## 4. 現在のスキーマ案

### ノード型 (16 型)

| 型 | 出自 | 説明 |
|---|---|---|
| Decision | system 持込 | 採用した判断 |
| RejectedOption | system 持込 | 退けた案 |
| Risk | system 持込 | リスク |
| Constraint | system 持込 | 自分たちの制約 |
| Goal | system 持込 | 目的・到達点 |
| OperationalKnowledge | system 持込 | 知見・ベストプラクティス (Lesson もここに吸収) |
| Investigation | system 持込 | 調査 |
| Source | File の差替 | 外部情報源 (URL + 鮮度管理 + refresh_method) |
| Theme | Vein の差替 | プロジェクト間の横断関心 (optional) |
| Stakeholder | 新設 | 利害関係者。関心事・影響力・コミュニケーション要件 |
| Resource | 新設 | ヒト・モノ・カネ・時間。capacity + allocation + refresh |
| Milestone | 新設 | 時間軸の到達点。Goal を時間に接地 |
| Assumption | 新設 | 前提・仮定。certainty level 付き。事業計画の仮定ツリーも担う |
| Agreement | 新設 | 外部との約束事・境界条件 |
| Task | 新設 | 判断に関わる粒度の作業の塊 |
| ConversationChunk | そのまま | 会話ログ保存用 |

### エッジ型 (20 型)

#### 出自・根拠系 (provenance)

| Edge | From | To | 意味 |
|---|---|---|---|
| documented_by | Decision, RejectedOption, Risk, OK, Agreement | Source | 「この Source に記録・証拠がある」 |
| derived_from | Decision, RejectedOption, Risk, OK, Goal, Assumption, Task | ConversationChunk, Investigation, Source | 「ここから導かれた」(出自・起源) |

documented_by = 「どこに書いてあるか」、derived_from = 「どこから来たか」。Source が両方の先になりうるが、ConversationChunk は derived_from だけ (会話は出自であって証拠文書ではない)。

#### 判断・知識系

| Edge | From | To | 意味 |
|---|---|---|---|
| supersedes | Decision, OK | RejectedOption | 「この案を採用し、あれを退けた」 |
| has_premise | Decision, OK, Risk, Task, Goal, Assumption | Decision, Constraint, Goal, OK, Assumption, Agreement | 「これが前提」。Assumption→Assumption で仮定の連鎖も可 |
| refines | Goal→Goal, Decision→Decision, Task→Task | (同型) | 「上位を分解・詳細化したもの」 |
| led_to | Investigation | Decision, RejectedOption, OK, Risk | 「調査の結果こうなった」 |
| triggered_by | Investigation | Risk, Source, ConversationChunk, Assumption, Stakeholder | 「これがきっかけで調査開始」 |
| influences | OK | Decision, Risk, Task | 「前提ほど強くないが、この知見が判断を方向付けた」 |

#### 制約・リスク系

| Edge | From | To | 意味 |
|---|---|---|---|
| constrains | Constraint, Agreement | Decision, Task, Goal, OK | 「これを制限する」 |
| risks_in | Risk | Task, Goal, Milestone | 「このリスクはここに潜んでいる」 |
| mitigates | Decision, Task | Risk | 「これがリスクを軽減する」 |

risks_in と mitigates は逆ではない — 「どこにリスクがあるか」と「何がリスクを減らすか」は別の情報。Risk X --risks_in--> Task A と Task B --mitigates--> Risk X で A ≠ B が普通。

#### 計画構造系 (project 新設)

| Edge | From | To | 意味 |
|---|---|---|---|
| achieves | Task | Goal | 「この作業がこの目的に貢献する」 |
| depends_on | Task→Task, Milestone→Milestone | (同型) | 「これが先に完了しないと着手できない」 |
| targets | Task, Goal | Milestone | 「この期限/チェックポイントを目指す」 |
| falls_back_to | Task→Task, Goal→Goal | (同型) | 「駄目だった場合の代替」PlanB。連鎖可 |
| requires | Task | Resource | 「この作業にこのリソースが必要」 |

#### ステークホルダー系 (project 新設)

| Edge | From | To | 意味 |
|---|---|---|---|
| concerned_with | Stakeholder | Goal, Decision, Risk, Task, Milestone, Theme | 「この利害関係者はこれに関心がある」 |
| responsible_for | Stakeholder | Task, Goal, Milestone, Agreement | 「この人/ロールがこれの責任者」 |
| party_to | Stakeholder | Agreement | 「この合意の当事者」 |

3つに分けた理由: concerned_with = 「関心がある」(観察者)、responsible_for = 「責任を持つ」(実行者)、party_to = 「当事者である」(署名者)。同じ人が全部持つこともある。

#### 横断系

| Edge | From | To | 意味 |
|---|---|---|---|
| encompasses | Theme | Goal, Decision, Risk, Task, Resource, Assumption | 「このテーマがこれらを横串で束ねる」 |

#### system vault から削除したもの
- `sets_policy_for` (Decision→File) — File がないので不要。has_premise と constrains でカバー
- `evidenced_by` (Vein→File) — Theme は encompasses で直接ノードを束ねる。Source への根拠は documented_by で足りる

---

## 5. ユーザー作成の PdM/PjM チェックリスト

ユーザーが一般メンバー向けに噛み砕いて書いたチェックリスト。これがプロジェクト vault のcarving check (= graph の健全性を定期的に検査する仕組み) の原型になる。

### 整合性の監視 (ズレ検出)
- ゴールが利害関係者間で明確になっているか → Goal + Stakeholder + concerned_with のカバレッジ
- ゴールと現実の間に到達可能なステップを区切れているか → Goal→Task→Milestone の階層
- 状況が変化した際、ステップやゴールの見直しを行っているか → Assumption の certainty 変動検知
- 定期的にゴールと計画のズレがないか確認しているか → Goal↔Task の achieves 整合性
- 現状からの積み上げとゴールからの逆算の両方を行えているか → 双方向チェック

### リスク・順序の監視
- 計画が回り道になっていないか → depends_on チェーンの効率性
- 計画が失敗時大きくロスするような順序になっていないか → depends_on 後段 × Risk の集中検出
- 成功確率が高くない計画が含まれる場合、プランBが検討されているか → 高 Risk Task に falls_back_to が存在するか

### 人・境界の監視
- 利害関係者含む体制図が出来ているか → Stakeholder ノードの網羅性
- 役割を各メンバーが適切に行えているか定期的に確認しているか → responsible_for の定期レビュー
- 外部(別チームやユーザー)との境界部分の約束事が明確になっているか → Agreement ノードの存在
- 利害関係者と良好な関係を築くことが出来るか → Stakeholder のコミュニケーション要件
- 適切なタイミング・粒度で報連相できているか → Stakeholder の communication_need 属性

### スコープ・戦略の監視
- 分割可能な目的を1プロジェクトに押し込んでいないか → Goal の refines 構造
- 機能・仕様が利害関係者の落とし所だけで決められていないか → Decision の根拠品質
- リーンキャンバスに有るような項目を簡単に埋められるか → Goal/Constraint/Assumption のカテゴリカバレッジ
- 目の前の課題だけを解決するようになっていないか → Goal 階層の深さと戦略的 Goal の存在
- 現状からの積み上げとゴールからの逆算の両方を行えているか → 双方向計画チェック

---

## 6. 議論で出た多角的な検討材料

以下は結論ではなく、議論を豊かにした検討材料。次のセッションでも参照する価値がある。

### アリストテレスの四原因
| 原因 | プロジェクトでの対応 | 密度が高い情報 |
|---|---|---|
| 質料因 (何から) | リソース、人、予算、既存資産 | 制約条件・リソース配分の判断根拠 |
| 形相因 (何の形に) | アーキテクチャ、スコープ、設計 | スコープの境界線とその理由 |
| 動力因 (何が動かす) | イベント、意思決定、外部変化 | トリガーとなった事象・判断の連鎖 |
| 目的因 (何のために) | ゴール、ビジョン、成功の定義 | 「なぜこれをやるのか」の蒸留 |

project vault 固有の点: **動力因が時間軸で連鎖する**。「A が起きたから B を判断し、それが C のリスクを生んだ」という因果の流れが価値の本体。

### 暗黙知 / 形式知 (野中郁次郎)
graph が狙うべきは暗黙知の形式知化の受け皿:
- 判断の「本当の理由」(公式理由と違うことがある)
- ステークホルダー間の力学・温度差
- 「次回同じ状況になったら」のパターン認識

### TOC (制約理論) — ボトルネックの可視化
ボトルネックは移動する。graph で追跡する価値:
- 今のボトルネックは何か (人？技術？承認？)
- なぜそれがボトルネックになったか
- 過去にボトルネックだったものが解消された経緯

### Wardley Mapping — 進化段階
→ certainty level として一般化して Assumption に組み込んだ。

### 密度を上げた時に残るもの
1. 判断とその文脈 — Decision + 前提 + 却下案 + ステークホルダーの関心
2. 因果の連鎖 — 単独の事実より連鎖が価値
3. スコープ境界とその理由 — 「やらない」の判断こそプロジェクトの本質
4. 前提と仮説 — 最も腐りやすく最も価値がある
5. 学習パターン — プロジェクトを超えて持ち運べる唯一の資産
6. バージョン/ストリームのスコーピング — 上の全てが「どのコンテキストの話か」で意味が変わる
7. 情報ソース — Source ノード (上記 2.2)
8. リソースと制約条件 — ライブデータとして扱う必要あり (上記 3.3)

密度を上げると消えるもの: タスクの日次進捗管理、個別チケットの詳細。これらは Jira/Linear の領域。

---

## 7. 未決事項・次に議論すべきこと

### 7.1 具体プロジェクトでの叩き
ユーザーは具体プロジェクトを思い出しながらスキーマを検証したいと言っている（データは別PCにある）。16ノード型 × 20エッジ型で過不足がないか、具体例でぶつけて確認するフェーズ。

### 7.2 能動的監視の仕組み
チェックリストを carving check (graph 健全性の定期検査) としてどう実装するか。system vault の carving check はグラフ構造の品質検査だが、project vault のはプロジェクト健全性の検査になる。検査の頻度、トリガー、出力形式は未設計。

### 7.3 cross-vault query の具体的な仕組み
world_hints の延長か、新しい仕組みが必要か。複数 vault にまたがるリソース競合検出やパターンマッチングの具体設計は未着手。

### 7.4 バージョン/リリース並行の扱い
初期の議論で「Release/Stream を first-class ノードにして scoped_to エッジで接続する」案が出たが、16ノード案では明示的に入っていない。Task/Goal/Milestone の組み合わせで表現できるかもしれないが、検証が必要。

### 7.5 state 語彙の設計
system vault では Investigation = active/closed、Decision/OK = superseded のみ、Goal = planned/active/achieved/abandoned。project vault では Task や Milestone の状態管理が追加で要る。Assumption の certainty level は state とは別軸。

### 7.6 Stakeholder/Resource の属性設計
Stakeholder: interest (関心事), influence (影響力), communication_need (報連相の頻度・粒度)
Resource: category (people/budget/asset/time), capacity, allocated, refresh_method
これらの具体的なフィールド設計は未着手。

### 7.7 system vault の横断構造型名
Vein/Stratum/Pocket → system ドメインに寄せた名前に変えたい後悔がある。v1.3.0 で Layer/Concern/Component に戻したが、更に変えるかは未決。

---

## 8. 技術的コンテキスト

### スキーマプリセット機構 (実装済み)
前回セッションで実装済み。`graphrag/schema-registry.ts` に `registerPreset` / `resolveSchema` があり、VAULT.md の frontmatter `schema` フィールドでプリセットを選択する。project vault のスキーマはここに新プリセットとして追加する形になる。

### 現在の system vault スキーマ
- 12 ノード型: File, ConversationChunk, Decision, RejectedOption, Risk, Constraint, Goal, OperationalKnowledge, Investigation, Layer, Concern, Component
- 14 エッジ型: documented_by, derived_from, supersedes, has_premise, refines, constrains, risks_in, led_to, triggered_by, influences, evidenced_by, sets_policy_for, (その他)

### ファイル構成
- `graphrag/schema.ts` — SchemaDefinition interface, DEFAULT_SCHEMA
- `graphrag/schema-registry.ts` — resolveSchema, registerPreset, getPreset, listPresets, parseSchemaField
- `graphrag/schema-registry.test.ts` — 9 tests

project vault のスキーマは `schema-registry.ts` に新プリセットとして `registerPreset('project', { ... })` で追加する。
