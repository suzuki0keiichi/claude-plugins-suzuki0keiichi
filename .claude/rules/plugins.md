Must apply plugin-dev best practices to all agents and skills.

## ワークフロー (1人メンテナ運用)

PR は作らない。ブランチ作業は main に直接 merge して push する (draft PR を開かない)。

## バージョン管理

プラグインのバージョンをバンプする際は `.claude-plugin/plugin.json` の `version` フィールドを更新すること。プラグインシステムが参照するのは `plugin.json` のみ。

バージョンはスキル・フック・CLI など挙動が変わった時に上げる。ドキュメントのみの変更では上げない。

## graphrag-knowledge の責務境界

このプラグインが持つのは3つだけ: **器** (語彙/スキーマ/テンプレ — 記憶を残せる形)、**導線** (ask/hook/マーカー/resume — 記憶が行動可能な瞬間に届く経路)、**配線整合の決定的検査** (walker — 登記されたことと現実の突合)。設計思想の中身 (何が良い設計か、OOP 規範、プロセス規律の強制、完了定義) は持たない — それはプロジェクト側の領分。利用プロジェクトから「守れなかった」報告が来た時、器に思想を盛る方向の機能追加は原則却下し、記憶と導線の欠けとして解けるものだけを採る (graphrag:see constraint:graphrag-skill-dev:plugin-scope-no-doctrine)。「AI が後回しにして忘れる」「似たものを別の場所に作る」は思想ではなく記憶喪失の問題であり、このプラグインの中核責務。
