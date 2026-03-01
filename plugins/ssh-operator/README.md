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

サブエージェントは `ssh-op.sh` 経由で SSH コマンドを実行します。デフォルトでは毎回 Bash コマンドの実行許可を求められるため、以下の設定を **強く推奨** します。

`~/.claude/settings.json` の `permissions.allow` に追加:

```json
{
  "permissions": {
    "allow": [
      "Bash(*ssh-op.sh*)"
    ]
  }
}
```

これにより `ssh-op.sh` を含むコマンドが自動承認されます。

### より厳密に制限する場合

特定ホストのみ許可したい場合:

```json
{
  "permissions": {
    "allow": [
      "Bash(*ssh-op.sh myhost*)",
      "Bash(*ssh-op.sh prod-server*)"
    ]
  }
}
```

### プロジェクト単位で設定する場合

グローバル設定ではなくプロジェクト単位で許可したい場合は、プロジェクトルートの `.claude/settings.json` に同様の設定を追加してください。

## 前提条件

- `~/.ssh/config` にホストが設定されていること
- 鍵認証でパスワードなしで接続できること（`BatchMode=yes` で接続します）
