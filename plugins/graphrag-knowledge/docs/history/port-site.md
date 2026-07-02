# Port Site Notes

> **historical** — env 解決の記述は home-fallback 層 (`~/.graphrag/.env`) 導入前のもの。現行の正は SKILL.md §Setup。

利用先プロジェクトに graphrag-skill を組み込む時に必要な設定の一覧。
**初回移植時のみ参照**、日常運用では読まない。

## escalation / permission policy

どのコマンドに権限昇格が要るかは利用先のハーネス設定依存。v3 は vault (ファイル) と embedding endpoint へのアクセスが中心 (外部 graph DB は無い)。利用先の権限モデルに合わせてこの節を書き換える。スキルのロジックではない。

## env 命名 (GRAPHRAG_*)

- `GRAPHRAG_VAULT_DIR`: **vault 正本パス**。読み・書き・索引が全てここを見る。未設定でも cwd 上方向の規約パス `.graphrag/vault` を自動発見する (後述)。別の場所に置く時だけ明示する。
- `GRAPHRAG_EMBEDDING_ENDPOINT`: 明示指定 (省略時は Ollama / LM Studio を自動検出)。
- `GRAPHRAG_VECTOR_PROVIDER`: vector provider 上書き。
- `GRAPHRAG_VECTOR_INDEX_PATH`: vector index ファイルパス (省略時は vault/graph.json と同じ dir の `vector-index.json`)。
- `GRAPHRAG_STATE_DIR`: launcher の一時 state (.graphrag/ask-state.json 等) 出力先 (default `./.graphrag`)。
- `GRAPHRAG_GRAPH_JSON_PATH`: graph.json (索引器出力・往復検証用) 入出力パス。`index` / `carve` / `vault-build` / `vault-import` を使う時のみ必要。

これらは `.env` でも良いし、シェル env でも良い。`graphrag/cli.ts` は起動時に `.env` を 1 回読み、既に process.env に設定済みのキーは上書きしない (CLI flag / シェル env を優先)。

## vault の解決順 (env を ambient にしなくても素で通す)

`graphrag/cli.ts` は起動時、`GRAPHRAG_VAULT_DIR` が未設定なら **cwd から上方向に規約パス `.graphrag/vault` を探して自動発見**する (クロスプラットフォーム、`discoverVaultDir`)。解決順:

1. シェル env `GRAPHRAG_VAULT_DIR` (CLI flag `--vault` があればそれが最優先)
2. プロジェクト `.env` の `GRAPHRAG_VAULT_DIR` (起動時に 1 回読む)
3. 規約パス `.graphrag/vault` の自動発見 (cwd 上方向)

**狙い**: 利用先のプロジェクトルートに graphrag 用の `.env` を強制すると他ツールの `.env` と共生しづらい。`.graphrag/vault` を置くだけで env も `.env` も不要にし、graphrag 自身の名前空間で完結させる。これにより「env が ambient に読み込まれない → エージェントが『グラフを読んで』をファイル探索にフォールバックする」問題を断つ (LLM 側の束縛は SKILL.md §Anti-patterns)。

## データ出力先

vault は **スキルリポジトリ配下に default 出力しない** (利用先の知識がスキルリポジトリに混入するのを避ける)。

- `GRAPHRAG_VAULT_DIR`: 正本 vault のパス (例: `./.graphrag/vault`)。`ask` / `commit-mutation` / `add-*` が読み書きする。**規約パス `.graphrag/vault` に置けば未指定でよい** (上記 3 で自動発見)。
- `GRAPHRAG_GRAPH_JSON_PATH`: 索引/往復時のみ (例: `./.graphrag/graph.json`)。`index` の出力先 + `vault-build` / `vault-import` の入出力。

env / `.env` / `.graphrag/vault` 規約のいずれでも vault を解決できない状態で `ask` / `commit-mutation` / `add-*` を叩くと **エラー停止**で実行を拒否する (黙って lexical fallback / スキル配下 default 出力はしない、不可分原則)。

## graph.json の位置づけ (v3)

vault が **単一正本**。`graph.json` は索引器 (`index` / `carve`) の出力や round-trip 検証 (`vault-import`) の中間表現であって、正本でも常設成果物でもない。通常の知識書込では `graph.json` を生成しない (`commit-mutation` は graph.json を介さず直接 vault に原子書込する)。

> v3 (作業C) で外部 graph DB 連携は撤去済み。`GRAPHRAG_FALKOR_*` env・graphName 解決・graph 名前空間の概念は無い (vault は git worktree ごとにディレクトリ分離する)。
