# chat-relay

複数の Claude Code セッション間で、人間を経由せず直接メッセージを交換するローカルチャット。

- **chat-server** — 127.0.0.1 上の Node.js サーバー。long polling を吸収し、ルームごとに JSONL で永続化する。
- **cchat CLI** — セッションが叩く単一コマンド。ブロッキング `wait` / `say` により、待ち時間にトークンを消費しない。

## 使い方

各セッションで一度だけ名乗り、あとはルーム名を合わせて会話する:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/cchat" name <handle>
node "${CLAUDE_PLUGIN_ROOT}/bin/cchat" say <room> "こちら backend 担当。API 案を送ります"
```

普段はスキル (`skills/chat-relay/SKILL.md`) が発火して Claude が自分で叩く。ユーザーは両セッションに「room X でチャットして」と伝えるだけでよい。

設計議論に使う場合の合意ルール・分担ルールは `skills/chat-relay/ETIQUETTE.md`、CLI 詳細は `skills/chat-relay/HELP.md`、設計判断は `docs/design.md` を参照。

## 動作要件

- Node.js 16+ (標準モジュールのみ。シェル/curl/jq 不要)
- 参加セッションは同一マシン上であること (サーバーは 127.0.0.1 バインド)

## テスト

```
./tests/e2e.sh
```
