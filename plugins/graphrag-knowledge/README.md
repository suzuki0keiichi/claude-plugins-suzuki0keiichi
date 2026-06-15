# graphrag-knowledge

プロジェクトの永続知識グラフを vault（Obsidian Markdown）を単一正本として安全に読み書きする Claude Code プラグイン。

## 前提条件

| 必須 | 説明 |
|---|---|
| **Node.js 22.6+** | `--experimental-strip-types` で TypeScript を直接実行する |
| **Embedding endpoint** | Ollama / LM Studio / OpenAI 互換の埋め込み API。未設定なら Ollama (`localhost:11434`) と LM Studio (`localhost:1234`) を自動検出。モデルは `nomic-embed-text` に pin |

外部 graph DB は不要（vault = ファイルのみ）。ランタイム依存もゼロ。

## インストール

```
/plugin marketplace add suzuki0keiichi/claude-plugins-suzuki0keiichi
/plugin install graphrag-knowledge@suzuki0keiichi-personal-plugins
```

## セットアップ（プロジェクト側）

1. **初回索引**: プロジェクトのルートで `carve` を実行すると `.graphrag/vault` にグラフが生成される
2. **embedding endpoint**: Ollama か LM Studio が `localhost` で動いていれば自動検出される。別の endpoint を使う場合は `.env` に設定:
   ```
   GRAPHRAG_EMBEDDING_ENDPOINT=http://localhost:1234/v1
   GRAPHRAG_EMBEDDING_MODEL=nomic-embed-text   # 省略時は自動検出
   ```
3. **vault パス**: `.graphrag/vault` が自動発見される。別の場所に置く場合のみ `.env` で明示:
   ```
   GRAPHRAG_VAULT_DIR=/path/to/vault
   ```

## 使い方

プラグインインストール後はスキルが自動で CLI を呼ぶため、直接コマンドを叩く必要は基本的にない。

主なスキル:
- **graphrag-knowledge** — 知識の読み書き（着手前に `ask` で引く、一段落で書き戻す）
- **graphrag-pr-review** — PR/diff をグラフと照合してレビュー
- **graphrag-design-review** — 設計案をグラフと照合してレビュー
- **graphrag-review-doc** — 人間向けのレビュー説明資料（HTML）を生成

## テスト

```bash
node --experimental-strip-types --test graphrag/*.test.ts
```
