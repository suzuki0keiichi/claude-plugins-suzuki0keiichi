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
├── scripts/ssh-op.sh              # SSHヘルパー
└── skills/ssh-operator/
    └── SKILL.md                   # スキル本体（/ssh-operator コマンド兼用）
```

### コンポーネント

| 層 | ファイル | 役割 |
|----|---------|------|
| Skill | `skills/ssh-operator/SKILL.md` | `/ssh-operator <host> [task]` のエントリーポイント。Step 0 でヘルパーを `.claude/ssh-operator/` へ差分コピーし、メインエージェントに SSH 操作手順を注入 |
| Script | `scripts/ssh-op.sh` | SSH接続・出力制限(200行)・チルダ展開修正・エラー報告 |

スキルの Step 0 が `${CLAUDE_PLUGIN_ROOT}/scripts/ssh-op.sh` をプロジェクト内の `.claude/ssh-operator/ssh-op.sh` に差分コピーする（内容一致ならスキップ、プラグイン更新後は自動更新）。
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
| パス解決 | スキル Step 0 で `.claude/ssh-operator/ssh-op.sh` に差分コピー | キャッシュパスはプロジェクト外のため Always allow が効かない ([#11380](https://github.com/anthropics/claude-code/issues/11380))。スキル本文の `${CLAUDE_PLUGIN_ROOT}` はメインエージェントでは確実に展開される |

### SessionStart フック方式を廃止した経緯 (v0.4.0)

v0.3.x では SessionStart フックが毎セッション無条件にスクリプトをコピーしていたが、SSH を使わないプロジェクトにも `.claude/ssh-operator/` が散布される副作用があった。スキル起動時の差分コピー（Step 0）に置き換え、フックを廃止。当時フックを選んだ理由は「サブエージェント環境で `${CLAUDE_PLUGIN_ROOT}` が未展開」だったが、メインエージェント実行に移行済みの現構成ではスキル本文で問題なく展開される。

### サブエージェント方式を廃止した経緯 (v0.3.0)

v0.2.0まではサブエージェントで実行していたが、以下の問題が解決困難だった:

1. **`${CLAUDE_PLUGIN_ROOT}` 未展開**: サブエージェントのBash環境で利用不可。`find` での動的探索が必要に
2. **パーミッション問題**: マルチラインコマンドで「Always allow」が表示されない（Claude Code の prefix parser 制約）
3. **バージョン依存パス**: プラグイン更新でキャッシュパスが変わり、保存済みパーミッションが無効化
4. **description の few-shot 影響**: エージェント定義の example タグがモデル挙動を強く支配し、スキル指示が無視される

## スコープ外

- リモートへのClaude認証情報・プラグインのインストール
- SSH鍵の生成・配布の自動化
- 複数リモートホストの同時操作
