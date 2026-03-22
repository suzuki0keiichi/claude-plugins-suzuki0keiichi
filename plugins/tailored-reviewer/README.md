# tailored-reviewer

プロジェクト固有の知識を収集し、そのプロジェクト専用のレビュースキルを生成する Claude Code プラグイン。

## 着想

[sashiko](https://github.com/sashikorern/sashiko) のマルチパースペクティブレビューに触発されて開発。プロジェクト固有の知識注入と backtest による検証ループを加えた。

## 何を解決するか

汎用レビューツールは「一般的なバグ」は見つけるが、「このプロジェクトで繰り返されるバグ」は見つけられない。設計思想やロードマップとの整合性、プロジェクト固有のお作法への準拠はさらに難しい。

tailored-reviewer は、プロジェクトの歴史・設計原則・バグ傾向・チーム規約を学習した上で、そのプロジェクト専用のレビューパースペクティブ群を生成する。生成されたスキルは独立したエージェントとして並列実行され、短期的なバグ検出と長期的な設計品質の両面からレビューを行う。

## 特徴

**プロジェクト知識の構造的収集**
interview スキルがリポジトリ・バグトラッカー・設計文書等から知識を収集し、knowledge-base として構造化する。

**8つの必須パースペクティブ + ドメイン固有パースペクティブ**

| パースペクティブ | 観点 |
|----------------|------|
| execution-flow | 実行フロー、ガード条件の対称性、暗黙の契約 |
| resource-management | リソースのライフサイクル、リーク、タイムアウト |
| concurrency | 競合、デッドロック、ワークフロー干渉 |
| security | 認証漏れ、インジェクション、データ露出 |
| platform-constraints | 実行環境の制約、クロスプラットフォーム |
| implementation-quality | コーディング品質、サイレント失敗、ガード非対称 |
| code-health | 認知的負荷、技術的負債、設計整合性、可観測性 |
| strategic-alignment | 根本解決の妥当性、ロードマップとの整合 |

プロジェクトのアーキタイプ（Web / Backend / Embedded 等）に応じたドメイン固有パースペクティブも自動生成される。

**short-term / long-term の分離**
バグ・セキュリティ（short-term）と保守性・設計品質（long-term）を独立したファイル・独立したスコアで評価。長期目線が短期のバグ検出に埋もれない。

**backtest による検証ループ**
過去のバグ導入PRに対してレビューを再実行し、recall（検出率）と precision（的中率）を定量測定。結果からの学びがスキル生成にフィードバックされる。

## 使い方

```bash
# 1. レビューデータプロジェクトを作成
mkdir ~/review/my-project && cd ~/review/my-project

# 2. プロジェクト知識を収集
/interview

# 3. レビュースキルを生成
/build-skills

# 4. レビュー実行
/review PR #123

# 5. スキルの差分更新（プラグイン更新後など）
/update-skills

# 6. 過去PRでの検証
/backtest PR #456
```

## スキル一覧

| スキル | 用途 |
|--------|------|
| `/interview` | プロジェクト知識の収集（初回 + 更新） |
| `/build-skills` | レビュースキルの生成 |
| `/review` | レビューの実行 |
| `/update-skills` | スキルの差分更新 |
| `/backtest` | 過去PRでのrecall/precision測定 |
| `/debug-review` | 生成スキルの検証 |
| `/health-score` | プロジェクト健全性の定点観測 |
| `/submit-feedback` | プラグインへの改善提案 |
