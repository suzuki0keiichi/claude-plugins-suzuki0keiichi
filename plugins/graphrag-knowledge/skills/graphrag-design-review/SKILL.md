---
name: graphrag-design-review
version: 1.1.0
description: 設計案や approach を、コードを書く前にグラフ（プロジェクトの永続知識）と照合してレビューする AI 設計レビュー。「実装前にこの方針でいい?」「この設計どう思う」「この approach を見て」と、実装に入る前の設計・計画の是非や、過去判断・制約との整合・roadmap との親和性を確認したい時に使う。実装後の diff レビューは graphrag-pr-review、人間向けの説明資料は graphrag-review-doc。スラッシュ: /graphrag-knowledge:graphrag-design-review
---

# 設計レビュー（実装前・知識軸）

plan/設計時の高高度レビュー。approach の是非・roadmap 親和性・proportionality・ドメイン境界は、
diff 時にやると「やり直し」が残酷なので、実装前にここで見る。

共通の土台・CLI の呼び方・不変条件（hard reject しない / traceable / grep しない 等）は
**`${CLAUDE_PLUGIN_ROOT}/references/graph-review-method.md` を必ず先に読む**こと。本 skill はその
「知識軸（実装前面）」特化の手順だけを書く。

## 入力

レビュー対象の設計案 / approach / 計画。`$ARGUMENTS` に説明があればそれを、無ければ直近の会話文脈の設計案を対象にする。

## 手順

1. **領域の枠を引く（知識軸）**: 提案が触る領域について `ask` で1発引く。
   ```sh
   node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts ask "<提案領域> の Decision / Constraint / Goal / Risk / 却下案" --limit 8
   ```
   - 連打しない。必要なら `evidence <node-id>` で特定ノードの周辺を1, 2回だけ深掘り。
2. **照合する観点**（実装前に効く高高度の観点）:
   - **既存 Decision の暗黙の反故**: 提案がその領域の確定判断の意図を、明示せず崩していないか。
   - **却下案の再導入**: 提案が過去 RejectedOption と同じ approach か（= 過去ガード。再検討なら「なぜ今回は違うか」を要求）。
   - **Constraint 違反**: 守るべき制約を破っていないか。
   - **has_premise 逆引き（前提崩れの波及）**: 提案が反故/supersede する Decision に `has_premise` している
     **現役ノード**を逆引きで列挙し、前提が崩れたまま生き残るものが無いか見る（旧ノードへの has_premise は
     系譜保存で生き続けるので、列挙しないと波及が見えない）。
   - **roadmap 親和性**: 向かう先（status が planned/active な Goal）に対し遠回り/逆行か、撤回方向（abandoned）か。
   - **proportionality（大きさ）**: 変更が対象システムの posture（寿命/重要度/成熟）に対し過剰/過小か。posture が大域ゲインとして各観点の重みを再較正する。
   - **scope creep**: どの Goal にも紐づかない提案でないか。
3. **枠が引けない時**: 領域を統べる知識ノードが出てこなければ、`references/graph-review-method.md` §4 に従い
   「枠が領域に bind されていない疑い」を所見に明記（`edge-suggest-policy` を案内）。黙って「方針なし」としない。

## 出力

- 観点ごとに、**根拠ノード id を添えた**助言。断定でなく「枠を超える可能性。コードを変えるか、方針側を更新して意図変更を承認するかは人間が決める」形。
- **会計**: 観点ごとに「引いたノード数」を記す。**「該当なし」は会計付きでのみ書ける**
  （引く作業ゼロで「無し」と書くのを構造的に塞ぐ）。
- 重大な乖離（却下案再導入・Constraint 違反）は冒頭に **ACK 必須**として目立たせ、残りは advisory として添える。
- 最後に「この設計を採るなら vault に何を Decision/RejectedOption として残すべきか」を一言提案（graphrag-knowledge skill の書き戻しへ繋ぐ）。
