Must apply plugin-dev best practices to all agents and skills.

## ワークフロー (1人メンテナ運用)

PR は作らない。ブランチ作業は main に直接 merge して push する (draft PR を開かない)。

## バージョン管理

プラグインのバージョンをバンプする際は `.claude-plugin/plugin.json` の `version` フィールドを更新すること。プラグインシステムが参照するのは `plugin.json` のみ。
