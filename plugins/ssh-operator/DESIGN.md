# ssh-operator Design

## 目的

ローカルのClaude CodeからリモートマシンをSSH操作するプラグイン。

- ローカルにのみClaude認証情報・プラグインを集約
- リモートは共通PC（他ユーザーもsudo可能）→ 認証情報を置きたくない
- ヘルパースクリプト `ssh-op.sh` でトークン消費を抑える

## アーキテクチャ

```
ssh-operator/
├── .claude-plugin/plugin.json     # マニフェスト
├── hooks/hooks.json               # SessionStartフック（スクリプトコピー）
├── scripts/ssh-op.sh              # SSHヘルパー
└── skills/ssh-operator/
    └── SKILL.md                   # スキル本体（/ssh-operator コマンド兼用）
```

### コンポーネント

| 層 | ファイル | 役割 |
|----|---------|------|
| Hook | `hooks/hooks.json` | SessionStart時に `scripts/ssh-op.sh` → `.claude/ssh-operator/ssh-op.sh` へ自動コピー |
| Skill | `skills/ssh-operator/SKILL.md` | `/ssh-operator <host> [task]` のエントリーポイント。メインエージェントに SSH 操作手順を注入 |
| Script | `scripts/ssh-op.sh` | SSH接続・出力制限(200行)・チルダ展開修正・エラー報告 |

SessionStart フックが `${CLAUDE_PLUGIN_ROOT}/scripts/ssh-op.sh` をプロジェクト内の `.claude/ssh-operator/ssh-op.sh` に自動コピーする。
スキルとメインエージェントはプロジェクト内パスのみを参照し、直接リモート操作を行う。
プロジェクト内パスを使うことで「Always allow」のパーミッションパターンが安定する。

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
| 実行方式 | メインエージェント直接実行 | サブエージェント方式は `${CLAUDE_PLUGIN_ROOT}` 未展開・パーミッション問題が多く断念 |
| アプローチ | ヘルパースクリプト型 | リモートに何も置かず、コマンドミスを防ぎトークン効率も良い |
| 対話方式 | メインコンテキスト内 | コンテキスト消費はあるが、パーミッション周りが安定 |
| 操作範囲 | ローカル同等 | Read/Write/Edit/Grep/Glob/Bash相当をSSH越しで |
| トークン削減 | 出力200行制限 | 大出力によるトークン浪費を防止 |
| SSH接続 | ~/.ssh/config依存 | プラグインに接続情報を持たない |
| パス解決 | SessionStart フックで `.claude/ssh-operator/ssh-op.sh` に自動コピー | キャッシュパスはプロジェクト外のため Always allow が効かない ([#11380](https://github.com/anthropics/claude-code/issues/11380))。フックなら `${CLAUDE_PLUGIN_ROOT}` が確実に展開される |

### サブエージェント方式を廃止した経緯

v0.2.0まではサブエージェントで実行していたが、以下の問題が解決困難だった:

1. **`${CLAUDE_PLUGIN_ROOT}` 未展開**: サブエージェントのBash環境で利用不可。`find` での動的探索が必要に
2. **パーミッション問題**: マルチラインコマンドで「Always allow」が表示されない（Claude Code の prefix parser 制約）
3. **バージョン依存パス**: プラグイン更新でキャッシュパスが変わり、保存済みパーミッションが無効化
4. **description の few-shot 影響**: エージェント定義の example タグがモデル挙動を強く支配し、スキル指示が無視される

## スコープ外

- リモートへのClaude認証情報・プラグインのインストール
- SSH鍵の生成・配布の自動化
- 複数リモートホストの同時操作
