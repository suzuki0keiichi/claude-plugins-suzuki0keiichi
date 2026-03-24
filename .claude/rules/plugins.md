Must apply plugin-dev best practices to all agents and skills.

## tailored-reviewer バージョン管理

tailored-reviewer のバージョンをバンプする際は、以下の **両方** を必ず更新すること:
- `plugins/tailored-reviewer/VERSION`
- `plugins/tailored-reviewer/.claude-plugin/plugin.json` の `version` フィールド

プラグインシステムが参照するのは `plugin.json` であり、`VERSION` だけ更新しても反映されない。
