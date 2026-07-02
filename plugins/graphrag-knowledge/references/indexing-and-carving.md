# Indexing and Carving

**初回索引と概念化パスの手順**。typical な運用 (read / typed-add / commit-mutation) には登場しない。**未知のリポジトリを初めて索引する時に必ず読む**。

普段使いは `node graphrag/cli.ts carve --root <repo> --system <name>` で一括実行。本リファレンスはその内側で何が起きているか・カスタマイズしたい時の参照。

## 初回取り込み / 再索引

```sh
node graphrag/cli.ts carve --root <repo> --system <name> [--vault <dir>] [--previous <path>]
```

`--system <name>` は id 規約 `<typeSlug>:<system>:<slug>` の**名前空間ラベル** (System ノードは作られない)。indexer が生成するのは File / Component / Layer ノードと `evidenced_by` のみ。

内部で:
1. `index` (= `indexCodebase`) — git ls-files + content_hash + role 分類 + symbol/import 抽出。**File 要約も Component/Layer candidate 要約も「構成要素サマリ」(symbols/imports や束ねた File 群) の機械テンプレで、`summary_provisional: true` が立つ**(未完の自己申告)。概念化パスで「意味」(何をする/何のため/どの関心) に書き換え、このフラグを外すまで「未完」。
   **再索引で前回の本物 File 要約を継ぐのは正本 vault からだけ**(`<root>/.graphrag/vault` を自動解決、`GRAPHRAG_VAULT_DIR` / `--vault` でも指定可)。`--previous` の graph.json / indexed-graph.json scaffold は change_status 専用で、その summary は機械テンプレなので継がない(詳細は `cli-primitives.md` の index 節)。**よって「再索引 → vault を scaffold から作り直す」はやってはいけない**(再 author 済みの要約を握り潰す)。再索引が更新するのは scaffold(indexed-graph.json)で、vault は概念化パスの mutation でのみ書く。
2. `concern-hint` — vector index 経由で異なる Component をまたぐ File 群を Union-Find クラスタ化 (Concern の機械ヒント)。概念化パスで LLM がモデリングした Concern の盲点チェック用であり、Concern 発見の主役ではない (主役は LLM の概念的モデリング。`conceptual-pass.md` §2 参照)。**`summary_provisional` が残る File があると既定で拒否する**(テンプレ要約は embedding が言語語に支配され、クラスタが typescript/components 等に退化して縦串が無意味になるため。承知の上なら `--allow-provisional`)。
3. `edge-suggest-policy` — 各 Decision/OK/Risk に対し embedding 近接で sets_policy_for 候補抽出
4. `carving-check` — 品質ゲート (連番 slug / Layer 混入 / 網羅性 / 免除会計 / 重複 / 紐付け不在 / knowledge-floor / superseded-premise / superseded-no-successor)

**vector index が無い段階 (初回) でも 1 コマンドで通る**: carve は vector index 不在を検知すると、index 後に自動構築して suggest 系 (2・3) まで一気に進む (かつての「carve → `vector-index` → もう一度 carve」の 3 段の手動往復は不要)。embedding endpoint 不達時は従来どおり suggest 系を skip し、出力に明示注記が出る (非致命)。なお `GRAPHRAG_VECTOR_INDEX_PATH` は **vault 索引専用の env** であり、carve は読まない (carve の作業索引は `.graphrag/cache/` 配下の規約パス)。

**summary_provisional の ERROR 免除**: packaging / generated / lockfile 類の File は意味要約の強制対象外 (embedding から除外済み) — ERROR でなく INFO 件数として報告される。免除対象以外の実装 File に `summary_provisional` が残れば従来どおり ERROR。

## 足場と解釈の分担 (不変)

- **indexer は決定論の足場のみ**: git ls-files、content_hash / git_head による freshness、change_status、role 分類 (source/test/doc/config/...)、symbol/import 抽出、依存グラフ。**意味の解釈はしない**。File 要約は機械テンプレ (`summary_provisional: true`) として出し、意味は概念化パスに委ねる。出力は `validateGraph` 合格を自己検証し、そのまま概念化パス・`vector-index` 化に流せる(成果は `commit-mutation` で vault に適用)。
- **Component / Layer はグラフ距離で出す**: 依存コミュニティ検出 + hub 減衰 = Component 候補、依存トポロジ深さ帯 = Layer 候補。ヒューリスティック禁止。**indexer は canonical 名 (`Component` / `Layer`、id も `component:` / `layer:`) で出す**(旧 alias `Pocket` / `Stratum` は出さない)。
- **Concern は距離で出さない**: 横断 = 概念。**LLM がコードベース全体を俯瞰して概念的にモデリングする**のが主役。`concern-hint` (embedding 近接クラスタリング) は LLM のモデリング後の盲点チェック用。
- 役割考慮 retrieval (`DEFAULT_ROLE_WEIGHTS`) は既定 ON: 実装を doc/test/config/薄い入口より上位。`options.roleWeights` で上書き可。

足場の上に LLM が概念を乗せる。各成果は mutation プラン → `validateGraph` 0 失敗 → マージ。**スキーマ新型を足さない・増分のみ**:

## 概念化パス (graph-distance + 意味解釈)

1. **File 責務 summary の解釈生成** — retrieval 品質の主レバー・embedding 主担体。必ず `references/interpretation-guidance.md` に**厳密に従う**。changed File のみ更新。**機械テンプレ (`summary_provisional`) を本物の要約に書き換え、書き換えた File は `summary_provisional` を外す**(消し忘れると concern-hint 拒否・carving-check ERROR で機械検知される)。テンプレ(パス・役割・依存の機械再掲)のまま残す = サボり。
2. **Component/Layer 命名・Concern 概念グルーピング (横断)・概念 doc 蒸留・git 履歴→知識** — 必ず `references/conceptual-pass.md` のスキーマ合法マッピングに**従う**。切り方・粒度・命名・網羅性・増分追従の品質ルールは `references/carving-rules.md` を厳守 (conceptual-pass.md は「手順」、carving-rules.md は「品質ガード」の役割分担)。**indexer が出す Component/Layer candidate の summary は「構成要素サマリ」(束ねた File 群の機械テンプレ) で `summary_provisional: true` が立つ。命名時に「意味」(その機能境界/アーキ層が何を担うか) の summary に書き換え、provisional を外す**(File summary と対称。残すと carving-check ERROR)。
3. **carving 品質ゲート** — mutation apply 前に `carving-rules.md` の「carving 提出前チェックリスト」を通す。特に **要約の provisional 残存禁止 (`summary-provisional` ERROR。File / Component / Layer candidate 共通)**・網羅性ゲート (`src/` 配下 File は Component / Layer に所属)・連番 slug 禁止・Component と Concern の二重表現禁止は強制。`carving-check` は canonical / 旧 alias どちらの型名でも検出する (`canonicalType` 正規化)。
4. **知識軸シーディング (初回索引時の知識収穫)** — carve 完了後、`harvest-history --root <repo> [--system <name>] [--out <path>]` で git 履歴から revert コミット (= `RejectedOption` candidate) とコメントマーカー HACK / FIXME / WORKAROUND / XXX (= `OperationalKnowledge` / `Risk` candidate) を**決定論抽出**する (書き込みなし・candidate JSON。concern-hint と同じ思想で、採否は LLM が個別判断して typed-add)。あわせてユーザーへの短いインタビューで Goal ツリー (refines で 3〜7 個) と主要 Constraint を起こす。手順は `references/conceptual-pass.md` の「知識軸シーディング」。Goal 0 件のまま放置すると `carving-check` が `knowledge-floor` WARN (`knowledge-floor-goal-missing`) を出し、design-review の scope-creep / roadmap 観点が無効なままになる。

設計根拠・意図的な非対応は `references/carving-rationale.md`。実証の履歴 (5/5 収束、無コンテキストで影響波及追跡、品質回帰ゲート) は `docs/history/indexer-redesign-notes.md` (historical)。

## 同梱 references (carving 関連)

- `references/carving-rationale.md`: なぜこの 12 ノード型/このエッジ文法/RejectedOption 一級/Layer≠Concern≠Component/Symbol 非ノード。スキーマ定義の中核価値。
- `references/interpretation-guidance.md`: **File 解釈 summary の汎用ガイダンス**(LLM が従う。リポ/クエリ非依存)。retrieval 品質の主レバー。
- `references/conceptual-pass.md`: 概念解釈パスのスキーマ合法マッピング (Component/Layer 命名・Concern 概念グルーピング・doc 蒸留・git 履歴→知識・知識軸シーディング)。**手順**を規定。
- `references/carving-rules.md`: Component / Concern / Layer の切り方・粒度・命名・異物検査・網羅性ゲート・増分追従の **品質ガード**。conceptual-pass.md の各 step で本ルールを満たすこと。carving 提出前チェックリストを必ず通す。
- `docs/history/indexer-redesign-notes.md` (historical): indexer エッセンス・再設計指針・実力 eval の実測と 5/5 収束ログ。
