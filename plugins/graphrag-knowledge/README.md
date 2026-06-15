# graphrag-skill

GraphRAG knowledge base for Claude Code: vault(Obsidian Markdown)を単一正本とする知識グラフを、単一 launcher 経由で LLM-safe に読み書きするスキル + CLI。v3 で外部 graph DB(FalkorDB)依存は撤去済み。

## Requirements

- **Node 22.6+**（`--experimental-strip-types` で TypeScript を直接実行。型ストリップは 22.6 以降）
- OpenAI 互換 embedding endpoint（Ollama / LM Studio / OpenAI 等）。未設定なら Ollama(`http://localhost:11434/v1`)と LM Studio(`http://localhost:1234/v1`)を自動検出し、埋め込みモデルは `nomic-embed-text` に pin。
- 外部 graph DB は **不要**（vault = ファイルのみ）。

ランタイム依存はゼロ。devDeps（`typescript` / `@types/node`）は IDE / 型チェック用に任意。

## Install（Claude Code プラグイン）

このリポはそれ自身が単一プラグイン用マーケットプレイスを兼ねる。Claude Code で:

```
/plugin marketplace add suzuki0keiichi/graphrag-skill
/plugin install graphrag-knowledge@graphrag-skill
```

install 後はスキル(`skills/graphrag-knowledge/SKILL.md`)の手順に従い、CLI は `${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts` 経由で呼ばれる。利用先プロジェクトで出力先 env を `.env` に設定する（初回必須、詳細は `references/port-site.md`）:

- `GRAPHRAG_VAULT_DIR`: vault 正本パス（必須。未設定で `ask` / `commit-mutation` / `add-*` はエラー停止）
- embedding endpoint 系（省略時は自動検出）

## Local / development（clone して直接使う）

プラグイン機構を使わずリポを直接動かす場合は、リポ root を作業ディレクトリにして相対で叩く（`${CLAUDE_PLUGIN_ROOT}` は不要）:

```bash
git clone https://github.com/suzuki0keiichi/graphrag-skill
cd graphrag-skill
node --experimental-strip-types graphrag/cli.ts inspect   # env / artifacts の状態を JSON で出力
```

## Usage

```bash
node --experimental-strip-types graphrag/cli.ts <verb> [args]
```

**Headline verbs（連鎖、1 コマンドで複数段）:**

- `ask "<質問>"` ── retrieval ladder の自動段上げ（brief→search→evidence）、`--call-number` 自動。`--gist "<想定答えの一行>"` で質問と gist を別々に埋め込み両方で照合（semantic は cosine の max）、`--graph-rerank on|off`（既定 off。実 vault 実測で hub 偏重のため opt-in）でグラフ隣接ブースト
- `carve --root <repo> --system <name>` ── 初回索引 + 概念候補抽出 + 品質ゲート
- `commit-mutation <plan.json>` ── plan を vault に検証適用（lock / OCC / 原子 delta / vector 索引更新 / git commit、commit 失敗は all-or-nothing）
- `add-decision | add-ok | add-risk | add-constraint | add-goal | add-investigation | add-rejected-option` ── 引数だけで知識追加（vault に直接書く）
- `inspect` ── 状態確認（env / vault / graph.json / vector-index / binding_debt=bind 無し knowledge ノード数）

typed-add 共通フラグ: `--aliases "a,b,c"`（embedding / lexical 完全一致に効く別名）。エッジフラグはスキーマ文法に厳密対応し、`add-decision` は `--sets-policy-for` / `--premise` / `--reduces-risk` / `--refines` / `--from-investigation`、`add-ok` は `--premise` / `--reduces-risk` / `--refines`、`add-risk` は `--risks-in`、`add-constraint` は `--constrains <id,...>`（必須 ≥1）、`add-goal` は `--refines` / `--derived-from` / `--state`。違反する宛先型は黙って落とさず明示エラーで停止。

**Primitive verbs（段別細粒度制御）:** `brief / search / evidence / index / vector-index / vault-build / vault-import / concern-suggest / edge-suggest-policy / carving-check / branch-merge / world-refresh / carving-allow / harvest-history / staleness-check`

- `vector-index --vault <dir> [--prefix-policy auto|off]` ── ベクトル索引構築。`auto`（既定）は登録モデル（`nomic-embed-text`）に `search_document:` / `search_query:` 接頭辞を適用し索引メタに記録（クエリ側は索引メタを読んで対称に付与。旧索引には付けない）。`off` で接頭辞ポリシー無効化

- `carving-allow add|remove|list|migrate` ── 孤児免除設定 `.graphrag/carving.json` の管理（人間所有の概念層。literal path のみ、原子書き + git commit 試行）
- `harvest-history --root <repo>` ── git 履歴から revert（RejectedOption 候補）と HACK/FIXME/WORKAROUND/XXX（OK/Risk 候補）を決定論抽出して candidate JSON を出す（書き込みなし、採否は LLM 判断）
- `staleness-check --root <repo>` ── 知識ノードの根拠 File がノード作成後に何コミット動いたかを数え、閾値超え（既定 5）を陳腐化候補として列挙（読み取り専用・意味判断なし）

詳細は `skills/graphrag-knowledge/SKILL.md`（LLM 向け）と `references/cli-primitives.md`（全 flag）。

### Hooks

プラグインは PreToolUse hook（`hooks/hooks.json` → `hooks/proactive-persistence-reminder.mjs`）を同梱する。`git commit` を含む Bash 実行時だけ「採用判断・却下案・リスク・運用ハマりを graphrag に書き戻したか」を非ブロッキングで注意喚起する（deny はしない）。

### Windows

shebang は効かないので `node --experimental-strip-types graphrag/cli.ts <verb>` 形を使う。PowerShell / cmd どちらでも可。

### Tests

```bash
node --experimental-strip-types --test graphrag/*.test.ts
```

## 設計の確定スコープ

- **vault が単一正本**。知識は vault（frontmatter=正・本文=人間投影）に格納し、検索・索引・書き込みは全て vault を読む。`graph.json` は索引器出力・往復検証用の中間表現で正本ではない。
- **semantic は非交渉**。品質の落ちた lexical 単独 retrieval を一級サポート経路にしない（ベクトル索引が無ければ `ask` は明示エラーで停止）。
- embedding endpoint 欠落・モデル不一致はサイレントに倒さない（大声で停止）。
- vault は往復シリアライズ、frontmatter が正・本文は人間投影。
- 並行作業は vault の git ブランチで隔離し、merge はノード/エッジ単位の意味判断で行う（`branch-merge` が読み取り専用の判断パケットを出す）。

詳細は `references/cutout-spec.md`、移植単位は `references/migration-manifest.md`、移植時の env 一覧は `references/port-site.md`。

## 履歴の要点

- **v3（作業C）**: 外部 graph DB(FalkorDB)連携を撤去。vault が単一正本になり、`commit-mutation` / `add-*` は vault に直接原子書込（lock / OCC / 索引 / git commit）。FalkorDB 関連 verb（`mutate` / `falkor-*` / `list` / `drop` / `branch` / `worktree-drop`）は廃止。`branch-merge`（vault git ブランチの意味的 merge 分析）を新設。
- **v2.0.0**: 全 verb を `node graphrag/cli.ts <verb>` に統一（`pnpm graph:*` 撤去）、`contains` エッジの id 規約自動付与、`ask` の `--call-number` 自動加算、SKILL.md に Proactive Persistence / Drift Reconciliation 節追加。
