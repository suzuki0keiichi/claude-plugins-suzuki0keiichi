# スキーマ早見

`graphrag/schema.ts` の `NODE_TYPES` (12) と `EDGE_TYPES` (14) が正本。

## ノード型 (12)

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

## エッジ型 (14) と許容組 (from-type → to-type)

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

## ID 規約

`<typeSlug>:<system>:<slug>` (例 `decision:graphrag:vault-single-source`)。`<system>` は **id の名前空間ラベル** (System ノードは作られない)。typed-add CLI の `--system` もこのラベルを指す。

## state 語彙

`schema.ts` の `STATE_VOCABULARY` が正本、`validateGraph` で強制。

| 型 | 許される state |
|---|---|
| `Investigation` | `"active"` \| `"closed"` (`add-investigation` の既定は `"active"`、`--state` で上書き可) |
| `Decision` / `OperationalKnowledge` | `"superseded"` のみ (state 無し = 現役) |
| `Goal` | `"planned"` \| `"active"` \| `"achieved"` \| `"abandoned"` |

上記以外の型に state があれば validation failure。語彙外の値も failure (typo ゾンビ検出)。state 無しは常に合法。

## 方針転換レシピ

Decision を覆す正規手順。文法は変えない — `supersedes` は Decision|OK → RejectedOption のまま:

1. 新 Decision を作成し、mutation plan で `refines`: 新→旧 を張る (系譜)。
2. 同じ plan で旧 Decision を op:update で `state: "superseded"` にする。
3. 反転で捨てたアプローチが再誘惑されうる場合のみ RejectedOption を新設し、新Decision -`supersedes`-> それ を併設する。

旧ノードへの `has_premise` 流入エッジはそのまま生きる (系譜保存)。plan 雛形は `mutation-templates.md`。
