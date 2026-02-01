# Project Coordinator Plugin

複雑で不確実性の高いタスクを管理するためのプラグイン。進捗を可視化し、目的を見失わないようにする。

## 構成

```
plugins/project-coordinator/
├── skills/
│   └── project-management.md   ← メインエージェントが使うスキル
├── agents/
│   ├── investigator.md         ← 調査専門エージェント
│   └── purpose-extractor.md    ← 目的抽出エージェント
└── resources/
    └── ...                     ← テンプレート、ベストプラクティス
```

## セットアップ

### 1. rulesにトリガーを追加

`~/.claude/rules/` に以下のファイルを作成してください:

```markdown
# ~/.claude/rules/project-coordinator-trigger.md

以下の場合、`plugins/project-coordinator/skills/project-management.md` を読み込み、その指示に従うこと:

1. **複雑なタスク開始時**
   - 3ステップ以上のタスク
   - 不確実性が高い作業（解決策が不明、複数の試行が予想される）
   - 進捗を見失いやすい作業

2. **進行中のプロジェクトがある時**
   - `.claude/project-coordinator/` ディレクトリにファイルが存在する場合
   - compaction後も必ず確認すること
```

### 2. プラグインのインストール

このリポジトリをcloneし、Claude Codeのプラグインとして登録してください。

## 使い方

### 自動トリガー

rulesを設定しておけば、該当する状況で自動的にスキルが読み込まれます。

### 手動で開始

複雑なタスクを開始する時:

```
「このタスクはproject-managementスキルを使って進めてください」
```

### 調査が必要な時

スキルの指示に従い、investigatorエージェントに委譲されます。

## アーキテクチャ

```
[User] ←→ [Main Agent + project-management skill]
                    ↓
           ┌───────┴───────┐
           ↓               ↓
    [investigator]  [purpose-extractor]
```

- **メインエージェント**: オーケストレーション、ユーザーへの報告
- **investigator**: 体系的な調査（仮説検証、根本原因分析）
- **purpose-extractor**: 目的の明確化、スコープ定義

## なぜスキル + エージェントの構成か

### project-managementがスキルである理由

- **ユーザーへの可視性**: メインエージェントが直接報告できる
- **compaction耐性**: rulesでトリガーされるので、会話が長くなっても忘れない
- **オーケストレーションの安定性**: サブエージェントとして「待つ」動作が不安定だった問題を解消

### investigatorがエージェントである理由

- **コンテキスト分離**: 調査は「掘り下げる」作業でコンテキストを大量消費する
- **メインの冷静さ維持**: 調査に没頭させつつ、メインは全体を俯瞰できる
- **単発実行との相性**: 「調査して結果を返す」というパターンはサブエージェントに適している

## 管理ファイル

プロジェクト進行中、`.claude/project-coordinator/` に以下のファイルが作成されます:

| ファイル | 管理者 | 用途 |
|---------|-------|------|
| purpose.md | メイン（スキル） | 不変の目的、成功基準 |
| plan.md | メイン（スキル） | 計画、進捗、リスク |
| work_summary.md | investigator | 調査結果のサマリー |
| work_log_XX.md | investigator | 調査の詳細ログ |
