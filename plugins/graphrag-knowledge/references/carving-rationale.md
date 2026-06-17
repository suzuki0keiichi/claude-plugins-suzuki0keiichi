# carving 根拠(なぜこのスキーマか)

このスキーマの価値は型の列挙ではなく、切り分けの判断とそれを支える不変条件にある。
書き起こさないと暗黙喪失するため、ここに残す。出自は gestalty の確定 Decision 群。

## ノード型(12)とそれぞれの存在理由

`graphrag/schema.ts` の `NODE_TYPES`。軸2(横断構造)は Layer/Concern/Component で命名する。
地質メタファー名 (Stratum/Vein/Pocket) は alias として残し `canonicalType` が Layer/Concern/Component に正規化する。

### 構造系 (File)

- root ノード型 (System / Product / Project / Business) は **v3.3 で撤去**。scope は vault 境界
  自体が担い (vault=scope)、所属は id 規約 `<typeSlug>:<system>:<slug>` が持つ。グラフ内の
  root ノードは scope の二重表現だった。vault の種別は将来 vault メタ層 (自己紹介の属性) で持つ。
- **File**: 構造の最小単位。embedding の主担体。シンボル/依存は配列フィールドで持つ
  (Symbol を独立ノードにしない、を下記で説明)。

### 知識系(蒸留知識)

- **Decision**: 採用した設計判断。`supersedes` で却下案を、`refines` で旧 Decision を継ぐ。
- **RejectedOption**: 却下した選択肢を**一級市民**にする。多くの ADR 的試みが "note" や
  "decision" に潰す所。「なぜ採らなかったか」はチームが最も失う情報なので独立させる。
  `rejected_in`(調査での却下)、`supersedes`(Decision が却下案を上書き)で接続。
- **Constraint**: 守るべき制約。`constrains` で Decision/File/OperationalKnowledge を縛る。
- **Goal**: システムの目的因・到達点 (要件 = 目的因 = 到達点)。v2 の Requirement を吸収。
  `refines` で上位 Goal を細分化、`has_premise` の前提・`derived_from` で出所に接地。
- **Risk**: 再利用されるリスク。`risks_in` で対象を、`reduces_risk` で緩和 Decision を結ぶ。
- **OperationalKnowledge**: 再利用される運用知見・ワークアラウンド。
- **Investigation**: 進行中/完了の調査。focus 継続の主語。`led_to` で Decision を生む。
- **ConversationChunk**: 出所となる会話メモ。蒸留知識の `derived_from` 先(出所必須)。

### 横断系(crosscut)

File 構造から独立に生き残るべき構造を3種に分ける:

- **Layer** (alias: Stratum): 水平に積もる層 = アーキテクチャ層。「どの層か」(縦の位置)。
- **Component** (alias: Pocket): 局所に凝集した塊 = 構造的まとまり(パッケージ/モジュール根)。「どこにあるか」(構造)。
- **Concern** (alias: Vein): 層や塊を貫いて走る筋 = 横断的関心事。File 構造とも層とも独立に生きるアーキ意図。
- 3種はいずれも `evidenced_by` で File を指す。File 移動で意図が消えないための分離。

## なぜ RejectedOption を一級にするか

「却下」を Decision の付帯情報にすると、後から「なぜその案を採らなかったか」を辿れ
なくなる。`supersedes` / `rejected_in` を持つ独立ノードにすることで、再検討時に同じ
議論を繰り返さない。これは情報の冗長ではなく、最も腐りやすい情報の保全。

## なぜ Layer ≠ Concern ≠ Component か

3つの直交する軸がそのまま切り分けの根拠になる:

- **Component** は「どこにあるか」(構造)。局所に凝集した塊。
- **Layer** は「どの層か」(縦の位置)。水平に積もる層。
- **Concern** は「何を横断的に気にしているか」(構造にも層にも縛られない意図)。層や塊を貫いて走る。
- これらを1種に潰すと、ファイル移動・リファクタでアーキ意図が構造と心中する。
- 3種を分け、確定は決め打ちせず LLM フレンドリ層に `judgment_input` を渡して委ねる
  (規則スコアで候補化 → LLM 最終判定)。指標は移植先ごとに変わるので規則を同梱しない。

## なぜ Symbol を独立ノードにしないか

シンボル/呼び出しグラフを独立ノード+エッジにすると、任意リポジトリでノード数が爆発し、
AST 無しの軽量インデクサでは精度も担保できない。現スキーマはシンボル/import を File の
配列フィールドに持たせ、embedding summary に織り込む(意味の担体は File 1枚)。
Symbol ノード型・call/参照エッジは現スコープ外の意図的な非対応。将来必要なら別途
スキーマ拡張の合意を経る(`NODE_TYPES`/`EDGE_TYPES` を勝手に増やさない)。

## エッジ文法(型ペア規則)の論理

`graphrag/schema.ts` の `EDGE_TYPE_RULES` が「何が何に繋がってよいか」を強制する。
これがグラフのスープ化を防ぐ一貫性契約。主な意図:

- `derived_from`: 蒸留知識 → ConversationChunk/Investigation のみ。**出所必須コントラクト**
  (知識ノードは raw_content を持つ合格出所へ辿れること)を構造で担保。
- `evidenced_by`: crosscut(Layer/Concern/Component) → File のみ。意図は必ず実体に接地。
- `contains` は **v3.3 で撤去** (唯一の「整理エッジ」だった)。所属情報は vault の存在と
  id 規約が既に持つため冗長。グラフに残すエッジは意味関係のみ。
- `supersedes`: Decision/OperationalKnowledge → RejectedOption。上書きの方向を固定。
- `led_to`: Investigation → Decision。調査が判断を生む流れを残す。

型ペアを破る変更は `validateGraph` が落とす。これは構造強制が runtime 非依存で
書かれた仕様であり、移植先でそのまま効く(スキーマ定義の中核価値)。

## 不変条件(スキーマ定義に含まれる契約)

- 出所必須: 蒸留知識は raw_content を持つ合格出所へ辿れること。
- 再利用知識のみ永続: session 限定メモ・未完ギャップ・推測は永続しない。
- focus 単位スコープ: session 単位挿入を禁止(重複・断片化の原因)。
- 新規より skip/update/supersede/review を優先。
- これらは「スキーマ定義」の一部。型表だけ移しても価値は移らない。
