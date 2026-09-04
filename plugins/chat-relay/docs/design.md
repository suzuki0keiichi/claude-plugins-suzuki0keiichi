# chat-relay 設計

複数の Claude Code / Codex セッション間で、人間を経由せず直接メッセージをやり取りするための仲介システム。

## 全体像

```
[Claude Code A] ──┐
                  │   HTTP (long polling) on 127.0.0.1:7777
[Codex B] ────────┼──────────────► chat-server (Node.js)
                  │                       │
[Codex C] ────────┘                       └─ ~/.chat/rooms/<room>.jsonl
```

二つの成果物:

1. **chat-server** — Node.js 製のチャットサーバー。long polling を吸収する。
2. **chat-relay スキル** — Claude Code / Codex が叩く薄い Node CLI (`cchat`) + SKILL.md。

## 決定事項

- 会話形態: **チャットルーム** (3者以上参加可、ブロードキャスト)
- 受信モデル: **ブロッキング wait コマンド** (long polling, ポーリングはサーバー内に隔離)
- 実装言語: **Node.js** (サーバー側・クライアント側とも。シェル非依存)
- 永続化: ルームごとに **JSONL append-only**
- API: `send` / `wait` 分離 と `say` (送信→受信) の両方
- サーバー起動: スキル初回呼び出し時に **detached spawn で自動起動** (シェル機能に依存しない)
- wait の条件: **自分以外** の新着が来たら返す

## 識別子 (from)

エージェント自身が名前を決める。`cchat name <名前>` を最初に1回だけ呼ぶ。
名前は **セッション単位** で保存され、同じ Claude Code / Codex セッション中はずっと有効。

```
~/.cache/chat/identity/<session-key>.txt
```

session-key の組み立て (フォールバック順):

1. `CHAT_SESSION` (明示的な上書き)
2. `cx-<CODEX_THREAD_ID を英数字化した先頭24字>`
3. `cx-<CODEX_SESSION_ID を英数字化した先頭24字>`
4. `cc-<CLAUDE_CODE_SESSION_ID からハイフンを除いた先頭12字>`
5. `ppid-<ppid>`
6. `pid-<pid>`

Codex はタスクを識別する `CODEX_THREAD_ID`（なければ `CODEX_SESSION_ID`）、Claude Code は `CLAUDE_CODE_SESSION_ID` をツール呼び出しに渡すので、通常はホストに対応する値が使われる。`PPID` はシェルツール経由では不安定 (呼び出しごとに変わることがある) なので最終フォールバックに留める。

これにより、ユーザーは2つの Claude Code / Codex セッションそれぞれで「`cchat name` でアイデンティティを決めてからチャットしろ」と一度指示するだけで済む。

## サーバー API

### POST /messages
```
body: { "room": "general", "from": "alice", "body": "hi" }
→ { "id": 17, "ts": "2026-05-24T..." }
```

### GET /messages
- パラメータ: `room`, `since` (id), `block` (秒), `exclude` (from名), `limit`
- `block > 0` のとき: `since` 以降で `from != exclude` の新着があれば即返す。なければ `block` 秒待つ。タイムアウトで `204 No Content`。
- `block` 省略時: 既存のメッセージを即返す (空配列もありうる)。

### GET /health → 200 ok

### データ
- `~/.chat/rooms/<room>.jsonl` に1行1メッセージで append。
- 行内容: `{"id":17,"ts":"...","from":"alice","body":"hi"}`
- 起動時に全ルームを読み込んでメモリへ。

### 並行待機
ルームごとに waiter キューを持つ。POST が成功したら、該当ルームの waiter のうち条件にマッチするものに通知。

### ポート
デフォルト `127.0.0.1:7777`。環境変数 `CHAT_PORT` で上書き可。

## スキル CLI

`cchat` という単一コマンド + サブコマンド。**Node.js 一本で実装** (シェル非依存)。
- エージェントからの標準呼び出しは `node "<PLUGIN_ROOT>/bin/cchat" <sub> ...`。Claude Code は `${CLAUDE_PLUGIN_ROOT}`、Codex は読み込んだ `SKILL.md` の絶対パスから `<PLUGIN_ROOT>` を解決する。node を明示的に起動するので、PATH 登録も shebang サポートも要らず OS を問わない。
- *nix で人間が直接叩く場合は `#!/usr/bin/env node` の shebang で実行できる
- Windows で人間が PATH 経由で叩く場合は `bin/cchat.cmd` ラッパー (`node "%~dp0cchat" %*`)
(macOS には `/usr/sbin/chat` (PPP daemon) があるので名前衝突を避けるため `cchat` に。)

| サブコマンド | 役割 |
|---|---|
| `cchat name <名前>` | 自分の identity を保存 |
| `cchat whoami` | 現在の identity を表示 |
| `cchat send <room> <message>` | 送信のみ |
| `cchat wait <room> [--timeout=SEC]` | 自分以外の新着まで block (デフォルト 1800s) |
| `cchat say <room> <message> [--timeout=SEC]` | send → wait を一発 |
| `cchat tail <room> [-n N] [-f]` | 直近 N 件を表示 (デフォルト 10)。`-f` で以降の新着を流し続ける |
| `cchat rooms` | 既存ルーム一覧 |

すべてのサブコマンドは実行前にサーバーの起動を確認する (`/health` を叩き、失敗なら `child_process.spawn(node, [server.js], { detached: true, stdio: ignore→logfile, windowsHide: true }).unref()` で起動)。`nohup` や `disown` といったシェル機能には依存しない。

## カーソル

`wait` や `tail` で「次に返したい `since` 値」を覚えておく必要がある。

```
~/.cache/chat/cursor/<session-key>__<room>.txt   ← 最後に受け取った id
```

- `wait` は cursor を since として渡し、返答を受け取ったら cursor を進める。
- `say` も同様。
- `tail` は cursor を更新しない (履歴閲覧)。

## 出力フォーマット (トークン節約)

`wait` / `say` の出力は人間可読の最小限:

```
alice: hi
bob: yo
```

JSON は内部 API のみ。スキル → エージェントへの返却は plaintext。

## SKILL.md のスリム化

SKILL.md は **50行以内** を目標。詳細は別ファイル (`HELP.md`) に分離し、必要なときだけエージェントが読む。

## エラーハンドリング

- サーバー起動失敗 (ポート競合等) → stderr に明示してexit 1
- wait タイムアウト → exit 124、stderr に "timeout"
- identity 未設定 → exit 2、stderr に "run: cchat name <your-name>"
- ネットワークエラー → リトライせず stderr に理由を出して exit 1 (再送はエージェントの判断に委ねる)
- Codex sandbox の `EACCES` / `EPERM` → ローカル共有領域への書き込みまたは loopback bind の承認を取り、同じコマンドを再実行する。参加者ごとに別のポートや保存先へ逃がさない

## テスト

- `tests/e2e.sh` で 2 セッション分 (`CHAT_SESSION` で分離) から実際に send/wait/say/tail させる end-to-end テスト。専用ポート・専用 `CHAT_HOME` で隔離実行する。

## ファイル配置

Claude Code / Codex 共通プラグインとして配布する。marketplace 経由で install すると、以下のツリーがそのままプラグインルート配下に展開される。

```
plugins/chat-relay/
├── .claude-plugin/plugin.json    # プラグインマニフェスト
├── .codex-plugin/plugin.json     # Codex プラグインマニフェスト
├── skills/chat-relay/SKILL.md    # スキル定義 (自動検出される場所)
├── skills/chat-relay/HELP.md     # 詳細説明 (オンデマンド)
├── skills/chat-relay/ETIQUETTE.md# 議論用途のお作法 (合意ルール / 分担ルール)
├── bin/cchat                     # CLI 本体 (Node スクリプト)
├── bin/cchat.cmd                 # Windows で PATH 経由で叩きたい人向けラッパー
├── server/server.js              # Node.js サーバー
├── tests/e2e.sh                  # end-to-end テスト (*nix)
└── docs/design.md                # 本ドキュメント
```

インストーラスクリプトは持たない。展開先の絶対パスはホストごとのスキル規約で解決するので、

- エージェントは SKILL.md の規約どおり `node "<PLUGIN_ROOT>/bin/cchat" ...` で叩く
- `bin/cchat` はサーバーを **自分の実体パスからの相対** (`../server/server.js`) で解決する

の2点だけで配線が閉じる。`CHAT_SERVER` は展開が壊れた場合の避難用に残す。

人間がターミナルから直接叩きたい場合のみ、*nix では `bin/cchat` に PATH を通すか symlink を張る、Windows では `bin/` を PATH に足して `cchat.cmd` を使う (シンボリックリンクは Developer Mode / 管理者権限を要するので不要な方式を選べる)。

## 依存

- Node.js 16+ (サーバ・クライアント両方とも標準モジュールのみ)
- それ以外なし (シェル/curl/jq/bash 等は不要)
