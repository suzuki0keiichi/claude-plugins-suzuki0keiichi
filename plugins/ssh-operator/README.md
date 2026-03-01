# ssh-operator

ローカルの Claude Code からリモートマシンを SSH 操作するプラグイン。

## 使い方

```
/ssh-operator <host> <やりたいこと>
```

例:
```
/ssh-operator myhost nginxの設定を確認して
/ssh-operator prod-server エラーログを調べて原因を特定して
```

`<host>` は `~/.ssh/config` に設定済みのホスト名を指定してください（鍵認証が必要です）。

## パーミッション

初回の SSH コマンド実行時に「Always allow」を選ぶと、以降は自動承認されます。

スクリプトは起動時にプロジェクト内（`.claude/ssh-op.sh`）にコピーされるため、パーミッションパターンがプラグイン更新の影響を受けません。

## 前提条件

- `~/.ssh/config` にホストが設定されていること
- 鍵認証でパスワードなしで接続できること（`BatchMode=yes` で接続します）
