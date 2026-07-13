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
- [embedding サーバを NPU で建てる](docs/embedding-npu.md) — プラットフォーム別の構築手順（Ubuntu / Intel NPU 実機検証済み）
- [graphrag-overview.html](docs/graphrag-overview.html) — 設計思想の俯瞰
- [graphrag-project-vault.html](docs/graphrag-project-vault.html) — project vault の解説

## 使い方

プラグインインストール後はスキルが自動で CLI を呼ぶため、直接コマンドを叩く必要は基本的にない。

主なスキル:
- **graphrag-knowledge** — 知識の読み書き（着手前に `ask` で引く、一段落で書き戻す）
- **graphrag-checkpoint** — 退避 → `/clear` で綺麗に再開（下記）
- **graphrag-stocktake** — Investigation ライフサイクルの定期クリーニング（下記）
- **graphrag-pr-review** — PR/diff をグラフと照合してレビュー
- **graphrag-design-review** — 設計案をグラフと照合してレビュー
- **graphrag-review-doc** — 人間向けのレビュー説明資料（HTML）を生成

## clear 引き継ぎ（checkpoint → 自動復元）

長時間セッションで避けられない情報ロストを、盲目的要約に任せず**狙って残す**。

- **退避**（手動）: 余力のある頃合いで `/graphrag-knowledge:graphrag-checkpoint` を撃つと、いまの作業状態と未書き戻しの恒久知識をグラフへフラッシュし、最後に `checkpoint-mark --investigation <id>` で「/clear されたら復元せよ」の one-shot 意図を刻む。ファイルは作らず `.graphrag/cache/ask-state.json` の予約キーに書く。
- **復元**（自動、`/clear` 直後のみ）: `SessionStart` フックが直前の意図を**読んだ時点で消費(一度きり)**して作業状態を再水和する。失効 60 分。**compact では何も注入しない**（旧来どおり compact 自身の要約に任せる）。auto-compact に飲まれた場合は、次セッションで `$CLI brief --mode resume` を手動で撃てば同じ Investigation から辿れる。

非 graphrag リポジトリでは no-op。細かい挙動は `graphrag-checkpoint` skill を参照。

## 棚卸し（Investigation の定期クリーニング）

閉じ忘れ・レガシー化した Investigation を、`stocktake` verb の機械検出 + `graphrag-stocktake` skill の裏取り裁定で `state:closed` に整える定期スイープ。閉じるだけで削除はしない。`brief --mode resume` が溜まりを検知すると `stocktake_hint` を返す。

## 登記層（Constraint の機械強制）

散文だけの Constraint はコードが違反しても何も落ちない（= 注意力頼みの強制に縮退し、日記化する）。これを防ぐ最小の結線が `enforced_by`:

- **新規 Constraint は enforcement の選択が必須**: `--enforced-by file:<s>:<path>`（破ったら落ちる検査 = テスト/lint/型）か `--unenforceable "<理由>"`（法規/SLA など機械強制できない外部条件の明示宣言）。
- **検査ファイル側にはマーカー** `// graphrag:enforces constraint:<system>:<slug> — <題>` を書く。グラフを引かない人がテストを消す/骨抜きにする瞬間に、現場で効く警告になる。規約を知らない読者も `graphrag` で辿れる（grep → `.graphrag/` → vault）し、`git grep graphrag:enforces` の1発でリポジトリの登記済み enforcer 一覧が出る。
- **`constraint-check` verb（walker）** が全 Constraint の配線を双方向で突合する: enforcer の消滅（error）・skip・マーカー孤児（tombstone 301 追跡）・未登記 enforcer（そのまま貼れる plan_fragment を返す）。全 finding が `next_step`（何が駄目か・どうすれば直るか）を持つ。CI では `--strict` で warn も赤にできる。
- `graphrag-pr-review` はレビュー冒頭にこの機械 pass を必ず走らせる（LLM 照合の前段）。

## 配置の地図（Component/Layer/Concern を「必ず見る」に近づける）

各セッションのエージェントが「今必要な」実装を思い思いの場所に置いていくのが、構造ドリフトの最大の発生源。禁止ではなく**地図を機械的に提示する**ことで配置を枠に寄せる（無所属は正当 — 小さいクラスタは Component を彫らないのが carving の思想なので、「属していない = 悪」とはしない）:

- **ask に area_map が毎回同乗**: 触る領域の登記済み Component/Layer/Concern の一覧。設計時に「見ない方が難しい」状態にする（発火実績のあるトリガーに地図を載せる）。
- **新規ファイル作成の瞬間に hook が局所地図を注入**（PostToolUse/Write）: そのディレクトリがどの Component の縄張りかをその場で提示。見せる地図が無ければ無音。
- **`frame-check` verb**: 高精度2判定のみ所見化 — `in-footprint-unwired`（一意の縄張り内に未配線 → 貼れる plan_fragment 同梱）と `component-candidate`（未登記の山が閾値超え = **Component が生まれたがっている**合図）。フラット配置では縄張りが重なるため誤発砲せず沈黙する。pr-review の機械 pass でも diff に対して走る。

## テスト

```bash
node --experimental-strip-types --test graphrag/*.test.ts   # CLI
node --test hooks/*.test.mjs                                 # フック
```
