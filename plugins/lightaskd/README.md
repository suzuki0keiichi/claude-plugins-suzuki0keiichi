# lightaskd

lightaskd は、AI エージェントから**明示的に呼び出したときだけ**使う、ローカルのタスク台帳です。データは手元の SQLite に保存されます。常駐デーモン、通知、スケジューラー、自動実行はありません。

たとえば「この Slack をあとで確認して」「金曜が期限」と普通に話しただけでは起動しません。

背景、設計判断、GraphRAG との役割分担、可搬性や性能の制約は [設計意図（DESIGN.md）](DESIGN.md) にまとめています。

## 必要環境

- Node.js 22.13 以上
- pnpm 10 以上

パッケージ操作には pnpm だけを使います。SQLite 用 npm パッケージや DB サーバーは不要です (ランタイム依存はゼロなので、CLI を使うだけなら `pnpm install` も不要です)。以下のセットアップと相対パスの CLI 例は、この plugin ディレクトリ (`plugins/lightaskd`) で実行します。

```sh
pnpm install
pnpm test
```

## 最初の台帳を作る

保存先を明示して、一度だけ初期化します。

```sh
node bin/lightaskd.mjs init --store ./private-tasks
```

以後は `--store ./private-tasks` を渡すか、`TASKBOX_DIR` を設定するか、`taskbox.json` があるディレクトリ配下から実行します。既知の台帳が見つからない場合、lightaskd は勝手に新しい DB を作りません。

## AI から使う

このディレクトリは [suzuki0keiichi-personal-plugins](../../README.md) マーケットプレイスの plugin として配布されています。スキルは [`skills/lightaskd/SKILL.md`](skills/lightaskd/SKILL.md) にあり、plugin をインストールすれば Claude Code / Codex の両方で同じスキルが使えます。

Claude Code の例:

```text
/plugin marketplace add suzuki0keiichi/claude-plugins-suzuki0keiichi
/plugin install lightaskd@suzuki0keiichi-personal-plugins
```

Codex は `.agents/plugins/marketplace.json` を参照するマーケットプレイスから同名の plugin をインストールします。

plugin として入れない場合は、このディレクトリをそのまま置き、`skills/lightaskd` をユーザーのスキルディレクトリ (Codex: `~/.agents/skills`、Claude: `~/.claude/skills`) からシンボリックリンクしても動きます。コピーではなくリンクにすると、このディレクトリの更新がそのまま反映されます。既に同名のパスがある場合は、内容を確認してから自分で差し替えてください。このリポジトリはグローバル領域へ自動インストールしません。

呼び出しは明示的なセレクターを使います。

```text
$lightaskd この内容を ./private-tasks に登録して。タイトルは「認証方式を反映」、説明は「Slack の決定事項を確認して認証方式へ反映する」、期限は 2026-09-10 18:00 JST、参照元は https://example.slack.com/archives/C123/p1234567890
```

Codex では `$lightaskd`、Claude Code では `/lightaskd:lightaskd` (plugin 名で名前空間付き) が明示呼び出しです。文中に `lightaskd` と名前を書くだけでは、製品によっては明示呼び出しとして扱われません。確実に使うにはセレクターを選ぶか入力してください。

この設定はスキルの自動選択を止めるものです。CLI を直接実行できるユーザーや AI に対する、OS レベルの DB 書き込み禁止機構ではありません。

## CLI で登録する

シェルの引用ミスを避けるには stdin JSON が便利です。

```sh
node bin/lightaskd.mjs add --store ./private-tasks --stdin
```

入力 JSON:

```json
{
  "title": "認証方式を反映",
  "query": "Slack の決定事項を確認して認証方式へ反映する",
  "due_at": "2026-09-10T18:00:00+09:00",
  "source_uri": "https://example.slack.com/archives/C123/p1234567890",
  "source_kind": "slack",
  "request_id": "codex:thread-id:turn-id",
  "graph_refs": [
    "vault:project-a/goal:project-a:remove-legacy-auth"
  ]
}
```

`title`、`query`、`source_uri` は必須です。`query` は保存するタスク説明であり、自動実行されるプロンプトではありません。`due_at`、`source_kind`、`request_id`、`graph_refs` は任意です。同じ登録を安全に再送する場合は、同じ `request_id` と同じ内容を使います。

成功時は stdout に `{"ok":true,...}`、失敗時は stderr に `{"ok":false,"error":{...}}` が出ます。AI は成功 JSON を確認してから登録完了と伝えます。

## 主な操作

```sh
node bin/lightaskd.mjs list --store ./private-tasks
node bin/lightaskd.mjs find "認証" --store ./private-tasks
node bin/lightaskd.mjs show TASK_ID --store ./private-tasks
node bin/lightaskd.mjs update TASK_ID --store ./private-tasks --title "新しいタイトル" --if-revision 1
node bin/lightaskd.mjs claim TASK_ID --store ./private-tasks --actor "codex:session" --if-revision 2
node bin/lightaskd.mjs done TASK_ID --store ./private-tasks --if-revision 3
```

更新系では `revision` と `--if-revision` を使うと、別プロセスの変更を知らずに上書きする事故を検出できます。全コマンドは `node bin/lightaskd.mjs help` で確認できます。パッケージが提供する CLI 名は `lightaskd` と後方互換の `taskbox` です。

## GraphRAG との境界

`graph_refs` は、呼び出し側が既に知っている参照文字列だけを受け取ります。lightaskd 自身は GraphRAG を検索・検証・更新せず、GraphRAG の起動も要求しません。リンクを追加・削除しても GraphRAG 側には通知されません。

既存の独立した GraphRAG 記録ルールを lightaskd が変更・置換・抑止することもありません。両者は独立した処理であり、lightaskd が新たな GraphRAG 起動条件を追加することもありません。

## バックアップ

SQLite の整合したスナップショットを作ります。

```sh
node bin/lightaskd.mjs snapshot --store ./private-tasks --to ./private-tasks-snapshot
```

クラウド同期フォルダ上の同じ DB を複数 PC から同時に開く使い方は対象外です。
