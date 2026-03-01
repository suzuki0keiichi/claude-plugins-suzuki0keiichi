# ssh-operator Design

## 目的

ローカルのClaude Codeからリモートマシンをサブエージェント経由でSSH操作するプラグイン。

- ローカルにのみClaude認証情報・プラグインを集約
- リモートは共通PC（他ユーザーもsudo可能）→ 認証情報を置きたくない
- サブエージェントで分離しコンテキスト汚染を防ぐ
- ヘルパースクリプト `ssh-op.sh` でトークン消費を抑える

## アーキテクチャ

```
ssh-operator/
├── .claude-plugin/plugin.json     # マニフェスト
├── agents/ssh-operator.md         # サブエージェント（Bashのみ）
├── scripts/ssh-op.sh              # SSHヘルパー
└── skills/ssh-operator/
    ├── SKILL.md                   # スキル本体（/ssh-operator コマンド兼用）
    └── evals/evals.json           # eval定義
```

### コンポーネント

| 層 | ファイル | 役割 |
|----|---------|------|
| Skill | `skills/ssh-operator/SKILL.md` | `/ssh-operator <host> [task]` のエントリーポイント。Agent toolでサブエージェントを起動、ホスト名・タスクを注入 |
| Agent | `agents/ssh-operator.md` | Bashのみ許可。全操作をssh-op.sh経由で実行 |
| Script | `scripts/ssh-op.sh` | SSH接続・出力制限(200行)・チルダ展開修正・エラー報告 |

### ssh-op.sh の使い方

```bash
ssh-op.sh <host> [行数制限] <コマンド...>

# 例
ssh-op.sh myhost cat -n /etc/config.yml
ssh-op.sh myhost 500 docker logs app
ssh-op.sh myhost grep -rn 'error' /var/log/
ssh-op.sh myhost tee /tmp/file.txt <<'EOF'
内容
EOF
```

## 設計判断

| 項目 | 決定 | 理由 |
|------|------|------|
| アプローチ | ヘルパースクリプト型 | リモートに何も置かず、コマンドミスを防ぎトークン効率も良い |
| ライフサイクル | タスク完了で終了 | サブエージェントの仕組み上自然。再操作は再呼び出し |
| 対話方式 | ハイブリッド | 基本は自律実行、不明点は結果に含めてユーザーに返す |
| 操作範囲 | ローカル同等 | Read/Write/Edit/Grep/Glob/Bash相当をSSH越しで |
| トークン削減 | 出力200行制限 + エージェント指示 | 大出力によるトークン浪費を防止 |
| SSH接続 | ~/.ssh/config依存 | プラグインに接続情報を持たない |

## スコープ外

- リモートへのClaude認証情報・プラグインのインストール
- SSH鍵の生成・配布の自動化
- 複数リモートホストの同時操作
