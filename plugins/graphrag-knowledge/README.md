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
4. **`.gitignore`**: `.graphrag/` には「知識（コミットするもの）」と「機械ローカル／再生成可能（コミットしないもの）」が同居する。後者は `cache/` 配下にまとまっているので、無視するのは 2 行だけ:
   ```gitignore
   # graphrag-knowledge — 機械ローカル / 再生成可能（コミットしない）
   .graphrag/.env      # vault パス・mode・embedding endpoint（マシン/worktree ごと）
   .graphrag/cache/    # ベクトル索引・索引出力・ask 履歴・ロック（すべて再生成可能）
   ```
   逆に **`.graphrag/vault/`（知識本体）・`.graphrag/VAULT.md`・`.graphrag/carving.json`（意図的な除外設定）は追跡したまま**にする。`.graphrag/` を丸ごと無視しないこと。

> `.env` の解決順、`VAULT.md` の書式、`.gitignore` の詳細、embedding サーバ（NPU 推奨）の詳細は **[セットアップマニュアル](docs/setup.md)** を参照。

## ドキュメント

- **[セットアップマニュアル](docs/setup.md)** — embedding サーバ / `.env` / `VAULT.md` の設定詳細
- [graphrag-overview.html](docs/graphrag-overview.html) — 設計思想の俯瞰
- [graphrag-project-vault.html](docs/graphrag-project-vault.html) — project vault の解説

## 使い方

プラグインインストール後はスキルが自動で CLI を呼ぶため、直接コマンドを叩く必要は基本的にない。

主なスキル:
- **graphrag-knowledge** — 知識の読み書き（着手前に `ask` で引く、一段落で書き戻す）
- **graphrag-checkpoint** — compact 対策の退避（下記）
- **graphrag-pr-review** — PR/diff をグラフと照合してレビュー
- **graphrag-design-review** — 設計案をグラフと照合してレビュー
- **graphrag-review-doc** — 人間向けのレビュー説明資料（HTML）を生成

## compact 対策（退避 → 自動復元）

長時間セッションで避けられない compact の情報ロストを、盲目的要約に任せず**狙って残す**。

- **退避**（手動）: 余力のある頃合いで `/graphrag-knowledge:graphrag-checkpoint` を撃つと、いまの作業状態（active Investigation の `raw_content`）と、未書き戻しの恒久知識（Decision / RejectedOption / Risk / 運用知識…）をグラフへフラッシュする。
- **復元**（自動）: `SessionStart` フックが `brief --mode resume` を注入し、直前 checkpoint を再水和する。**無操作**。発火する source は 2 つ:
  - **compact 直後**: 常に復元（auto-compact を含む。盲目的要約に curated な checkpoint を重ねる保険）。
  - **clear 直後**: 直前 checkpoint が**新鮮なとき（`generated_at` が 10 分以内）だけ**復元。古ければ真の白紙 — 無関係な作業のための `/clear` は邪魔しない。
- **おすすめの回し方**: 余力があるなら **`checkpoint` → `/clear` → 綺麗に再開**（盲目的要約ゼロで curated な状態だけが立ち上がる）。カツカツになって auto-compact に飲まれても、compact 側の復元が保険として効く。
- **無害化**: 非 graphrag リポジトリでは即 no-op（透明）。復元フックを黙らせたい時は `.graphrag/.env` に `GRAPHRAG_COMPACT_RESTORE=off`。
- auto-compact は捕捉できない（残 context signal が無いため）。checkpoint は人間が余力のうちに撃つ前提。

## テスト

```bash
node --experimental-strip-types --test graphrag/*.test.ts   # CLI（702 tests）
node --test hooks/*.test.mjs                                 # フック
```
