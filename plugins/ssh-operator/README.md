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

## SSH コマンドの許可設定（任意）

SSH コマンドは毎回許可を求められます。最初のコマンド実行時に「Always allow」を選ぶと、同じスクリプトパスのプレフィックスで許可パターンが保存されます。

**注意**: プラグイン更新でキャッシュパスのバージョン部分が変わるため、更新後は再承認が必要です。

これを避けたい場合、バージョンに依存しないワイルドカードパターンを手動設定できます:

### 特定ホストのみ許可（推奨）

```json
{
  "permissions": {
    "allow": [
      "Bash(\"*/ssh-operator/*/scripts/ssh-op.sh\" myhost *)"
    ]
  }
}
```

`myhost` を実際のホスト名に置き換えてください。

### 全ホスト許可（注意）

```json
{
  "permissions": {
    "allow": [
      "Bash(\"*/ssh-operator/*/scripts/ssh-op.sh\" *)"
    ]
  }
}
```

共有サーバーでの意図しない変更が心配な場合は、ホスト限定パターンを使うか都度確認してください。

## 前提条件

- `~/.ssh/config` にホストが設定されていること
- 鍵認証でパスワードなしで接続できること（`BatchMode=yes` で接続します）
