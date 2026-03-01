# ssh-operator

ローカルの Claude Code からリモートマシンをサブエージェント経由で SSH 操作するプラグイン。

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

## Bash コマンドの許可設定（推奨）

サブエージェントは起動時にヘルパースクリプトのパスを `find` で探索します。このコマンドは毎回実行許可を求められるため、以下の設定を **推奨** します。

`~/.claude/settings.json` の `permissions.allow` に追加:

```json
{
  "permissions": {
    "allow": [
      "Bash(find ~/.claude -name ssh-op.sh*)"
    ]
  }
}
```

これはローカルファイルの探索のみなので安全です。

SSH コマンド自体（`ssh-op.sh` 経由のリモート操作）は許可リストに入れず、都度確認することを推奨します。共有サーバーへの意図しない変更を防ぐためです。

## 前提条件

- `~/.ssh/config` にホストが設定されていること
- 鍵認証でパスワードなしで接続できること（`BatchMode=yes` で接続します）
