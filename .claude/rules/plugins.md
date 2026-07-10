Must apply plugin-dev best practices to all agents and skills.

## ワークフロー (1人メンテナ運用)

PR は作らない。ブランチ作業は main に直接 merge して push する (draft PR を開かない)。

## tailored-reviewer バージョン管理

tailored-reviewer のバージョンをバンプする際は、以下の **両方** を必ず更新すること:
- `plugins/tailored-reviewer/VERSION`
- `plugins/tailored-reviewer/.claude-plugin/plugin.json` の `version` フィールド

プラグインシステムが参照するのは `plugin.json` であり、`VERSION` だけ更新しても反映されない。
