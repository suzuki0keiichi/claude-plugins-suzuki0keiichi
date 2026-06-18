# Mutation Plan Templates

これらの plan は `node graphrag/cli.ts commit-mutation <plan.json>` で **vault に**検証適用する (vault が単一正本。書込経路は commit-mutation / add-* のみ)。

> **id の `<system>` について**: id 規約 `<typeSlug>:<system>:<slug>` の `<system>` は名前空間ラベル。
> 所属を表すエッジは不要 (v3.3 で contains は撤去。所属は vault の存在と id 規約が担う)。

typed-add (`add-decision` / `add-ok` / `add-risk` / `add-investigation` / `add-rejected-option` /
`add-goal` / `add-constraint`) でカバーされる頻出ケースは CLI 引数だけで済むので本テンプレートは不要。
**Goal / Constraint も `add-goal` / `add-constraint` で足りる**ようになった (エッジは `--refines` /
`--constrains` 等のフラグで張る。SKILL.md §典型 Recipe)。以下の Goal / Constraint テンプレは
複数ノード/エッジを一括で組む複雑ケース用に残置する。残る **Concern (横断関心)** と
**Update / Delete / 方針転換** 系は typed-add に無いので本テンプレートを使う。

---

## Concern (横断関心、evidenced_by で複数 File を指す)

層 (Layer) や塊 (Component) を貫いて走る横断的関心。エッジは evidenced_by のみ。

```json
{
  "reason": "新規 Concern <slug>",
  "nodes": [
    { "op": "create", "id": "concern:<system>:<slug>", "type": "Concern", "title": "...", "summary": "...",
      "description": "(任意) 蒸留散文。この関心が何を/なぜ横断するか。vault body `## 説明` に出る" }
  ],
  "edges": [
    { "op": "create", "id": "concern_<slug>__evidenced_by__file_<file_a_slug>",
      "type": "evidenced_by", "from": "concern:<system>:<slug>", "to": "file:<system>:<pathA>" },
    { "op": "create", "id": "concern_<slug>__evidenced_by__file_<file_b_slug>",
      "type": "evidenced_by", "from": "concern:<system>:<slug>", "to": "file:<system>:<pathB>" }
  ]
}
```

- `evidenced_by` は Concern → File (schema 上 `[ANY_CROSSCUT_NODE, "File"]`、ANY_CROSSCUT = Layer/Concern/Component)。`Layer` / `Component` の手動作成も同形 (evidenced_by で File に接地)。
- 2-5 個程度の File を束ねる典型。1 File しか繋がないなら Concern にせず File の summary に書き込むだけにする。
- **`summary` vs `description`**: `summary` = 1 行見出し (frontmatter・検索主担体)。`description` = 蒸留散文で **原則どのノードにも書く** (vault body に `## 説明` が round-trip marker 付きで出る・embedding にも入る)。集合系 (Concern 等が特に重要) は構成要素の列挙でなく「まとまりとして結局何なのか= what の正体」を、判断系 (Decision/Risk/Constraint/RejectedOption/OperationalKnowledge) は「なぜそう決めたか」を書く。判断系の生情報 (会話ログ・Slack URL 等) は捨てず `raw_content` か raw_content を持つ ConversationChunk/Investigation を source backing として残す。summary 丸写しにしかならない時だけ `description` を省く (空でも body に `## 説明` は出ない)。Goal / Constraint も同形。typed-add (`add-*`) でも `--description "..."` で指定できる。

## Goal (システムの目的因・到達点。v2 の Requirement を吸収)

> 単一 Goal は `add-goal --system <s> --slug <slug> --title "..." --summary "..." [--refines <goal-id>] [--state planned|active|achieved|abandoned] [--derived-from <id>]` で足りる。下記テンプレは複数ノードを一括で組む時用。

Goal 同士は `refines`、根拠への接続は `derived_from` / `has_premise` (詳細は SKILL.md スキーマ早見)。

```json
{
  "reason": "新規 Goal <slug>",
  "nodes": [
    { "op": "create", "id": "goal:<system>:<slug>", "type": "Goal", "title": "...", "summary": "..." }
  ],
  "edges": [
    { "op": "create", "id": "goal_<slug>__refines__goal_<parent_slug>",
      "type": "refines", "from": "goal:<system>:<slug>", "to": "goal:<system>:<parent_slug>" }
  ]
}
```

- 上位 Goal が無ければ `edges` は空でよい。出所会話/調査に接地するなら `Goal -derived_from-> ConversationChunk|Investigation` を足す。

## Constraint (制約、constrains で対象を指す)

> 単一 Constraint は `add-constraint --system <s> --slug <slug> --title "..." --summary "..." --constrains <id,...>` で足りる (`--constrains` 必須 ≥1、宛先 Decision|File|OK)。Constraint は documented_by 不可・evidence 不要。下記テンプレは複数 constrains を一括で組む時用。

```json
{
  "reason": "新規 Constraint <slug>",
  "nodes": [
    { "op": "create", "id": "constraint:<system>:<slug>", "type": "Constraint", "title": "...", "summary": "..." }
  ],
  "edges": [
    { "op": "create", "id": "constraint_<slug>__constrains__file_<file_slug>",
      "type": "constrains", "from": "constraint:<system>:<slug>", "to": "file:<system>:<path>" }
  ]
}
```

- `constrains`: Constraint → Decision / File / OperationalKnowledge。
- 「この制約が何を縛るか」を 1 つ以上の constrains で示す (特定 Decision / 特定 File / 特定 OK)。vault 全体に効く規範はグラフでなく CLAUDE.md / AGENTS.md に書く。

## Update (既存ノードの記述変更)

`type` / `from` / `to` は immutable。`summary` / `description` / `raw_content` 等の patch のみ。
**`updates` の値に `null` を渡すとそのフィールド自体を削除する** (例: `{ "state": null }` で state を取り下げる)。null が graph や frontmatter に残ることはない。

```json
{
  "reason": "<対象> の summary を最新の合意に合わせる",
  "nodes": [
    {
      "op": "update",
      "id": "decision:<system>:<slug>",
      "updates": { "summary": "<新しい summary>" }
    }
  ],
  "edges": []
}
```

## Delete (ノードを消す。touching edges は cascade)

```json
{
  "reason": "<理由>",
  "nodes": [
    { "op": "delete", "id": "decision:<system>:<slug>" }
  ],
  "edges": []
}
```

cascade される edge ID は `commit-mutation` 出力の `summary.cascaded_edge_ids` で確認できる。

## 方針転換 (Decision を覆す。supersedes の文法は変えない)

新 Decision を作り、(1) `refines`: 新→旧 を張り、(2) 旧 Decision を op:update で `state: "superseded"` にする。`supersedes` は Decision|OK → RejectedOption のまま — Decision 同士に張る文法は無い。旧ノードへの `has_premise` 流入エッジはそのまま生きる (系譜保存)。

```json
{
  "reason": "方針転換: <旧方針> を <新方針> で置き換える",
  "nodes": [
    { "op": "create", "id": "decision:<system>:<new-slug>", "type": "Decision", "title": "...", "summary": "...",
      "description": "なぜ転換したか (旧方針の何が成り立たなくなったか)" },
    { "op": "update", "id": "decision:<system>:<old-slug>", "updates": { "state": "superseded" } }
  ],
  "edges": [
    { "op": "create", "id": "decision_<new-slug>__documented_by__file_<file_slug>",
      "type": "documented_by", "from": "decision:<system>:<new-slug>", "to": "file:<system>:<path>" },
    { "op": "create", "id": "decision_<new-slug>__refines__decision_<old-slug>",
      "type": "refines", "from": "decision:<system>:<new-slug>", "to": "decision:<system>:<old-slug>" }
  ]
}
```

- 新 Decision にも source backing (`documented_by` File か raw_content 付き ConversationChunk/Investigation への `derived_from`) が必須。
- **反転で捨てたアプローチが再誘惑されうる場合のみ**、RejectedOption を新設し 新Decision -`supersedes`-> それ を併設する (RejectedOption にも source backing 必須):

```json
  { "op": "create", "id": "rejectedoption:<system>:<slug>", "type": "RejectedOption",
    "title": "<捨てた案>", "summary": "<なぜ再採用しないか>" }
```
```json
  { "op": "create", "id": "decision_<new-slug>__supersedes__rejectedoption_<slug>",
    "type": "supersedes", "from": "decision:<system>:<new-slug>", "to": "rejectedoption:<system>:<slug>" }
```

---

## Plan 共通形

```typescript
{
  reason: string,                   // 必須、なぜこの mutation を出すか
  nodes: Array<MutationNode>,       // op: create / update / delete
  edges: Array<MutationEdge>,       // op: create / delete (update は通常不要)
  duplicate_ack?: string[]          // 重複ゲートの suspect (既存ノード id) を確認済みとして通す時のみ
}
```

`validateGraph` (schema.ts) が:
- 未知の node type / edge type を拒否 (旧名 Stratum/Vein/Pocket は `canonicalType` で Layer/Concern/Component に正規化され通る)
- 未許可の (from-type, to-type) 組み合わせを拒否
- evidence backing が無い Decision/RejectedOption/Risk/OperationalKnowledge を拒否 (enforceSourceBacking)
- 同じ id の重複 create を拒否
- state は型ごとの語彙 (`STATE_VOCABULARY`) に限定: Investigation = active/closed、Decision/OperationalKnowledge = superseded のみ、Goal = planned/active/achieved/abandoned。他の型に state があれば拒否、語彙外の値も拒否 (state 無しは常に合法)

加えて vault writer の検証段に**書き込み時重複ゲート** (`duplicate_check`) がある: op:create の知識/横断ノード (File と ConversationChunk 以外) を `title+" "+summary` の embedding で同型既存ノードと照合 (cosine 0.92)。ヒット時は `duplicate_ack` が全 suspect を覆っていなければ all-or-nothing で reject (`failures` に `duplicate-suspect: <new-id> ~ <existing-id> (similarity 0.94)` 形式)。embedding endpoint 不達 / vector index 不在は非致命スキップ。typed-add からは `--dup-ack <id[,id...]>` で注入する。ゲートは最後の網 — `ask` での事前重複確認は依然必須。

エラー時は `commit-mutation` (vault writer) が `failures` 配列付き Error を投げ、vault は変更されない (all-or-nothing)。

---

## 書き込み出力の suggestions

`add-*` / `commit-mutation` は書き込み後、出力に `suggestions` オブジェクトを添える (全て **suggest-only・非致命**。index / endpoint 不在時は各提案を空+reason 付きで skip し、書き込みは決して止めない)。**提案は判断して確定するか、理由を持って見送る。自動では張られない** — これが境界 (エッジの自動付与はしない・確定は LLM/人間)。

- `suggestions.binding`: 作成した Decision/OK/Risk/Constraint について、vector index の File と embedding 照合した紐付け候補 (型ごと固定: Decision→sets_policy_for / Risk→risks_in / OK→documented_by / Constraint→constrains)。各候補に similarity と「そのまま実行できる確定手段」(typed-add フラグ or plan 断片) が付く → 妥当なら **その手段で確定**する。
- `suggestions.relations`: 同型ノードの cosine が [0.80, 0.92) 帯にある関係候補 (refines / has_premise / supersede のどれかは **LLM が判断** と note 付き)。中身を見て該当する関係を張るか見送る。
- `suggestions.led_to`: Decision 作成時に graph 内の `state:"active"` な Investigation を列挙 → その調査から導かれた Decision なら led_to を張る。
- `suggestions.premise_candidates`: ask-trail の直近ヒットのうち Decision/Constraint/Goal/OK 型 → 前提なら has_premise を張る。
- `suggestions.binding_debt`: bind 無し knowledge ノード総数 (carving-check #9 と同定義、Constraint 拡張込み) を整数 1 つで。増えていたら未紐付けの知識が溜まっている合図。

いずれも「判断して確定 or 理由を持って見送る」。提案をそのまま無言で放置しない (見送るなら見送る理由が言える状態にする)。
