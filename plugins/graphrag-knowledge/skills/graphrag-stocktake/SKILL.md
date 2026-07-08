---
name: graphrag-stocktake
version: 1.0.0
description: vault の Investigation ライフサイクル棚卸し(定期クリーニング)。state無しレガシーや、決着済みなのに active のままの focus を、機械検出(stocktake verb)+ 裏取り裁定で state:closed に整える。「棚卸しして」「vault を掃除/クリーニングして」「Investigation を整理して」「active が溜まってる」で発火。resume の stocktake_hint が出た時にも。削除はしない(閉じるだけ)。スラッシュ: /graphrag-knowledge:graphrag-stocktake
---

# Investigation 棚卸し（ライフサイクル定期クリーニング）

vault に溜まった Investigation の state を、機械検出 + 裏取り裁定で整える定期スイープ。read/write の土台・CLI 詳細は親 skill `graphrag-knowledge` と `$REF/`(= `${CLAUDE_PLUGIN_ROOT}/references`)に従う。`$CLI` = `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts`。

## 位置づけ（何をする skill で、何をしないか）

- 掃除の**主戦場は常設トリガ**(commit 前 nudge・checkpoint・実装一段落の書き戻し時点での closed 判断)。本 skill はその**取りこぼしを拾う後段の定期スイープ**であって、常設トリガの代わりではない。
- 検出は決定的 verb(`stocktake`)に委譲し、本 skill は**裁定だけ**を担う。LLM に vault を全読みさせない(§親skill Anti-patterns 準拠)。
- 発火は「棚卸しして」等の明示指示、または `brief --mode resume` が返す `stocktake_hint` を見た時。

## 手順

1. `$CLI stocktake [--days <N=14>] [--vault <dir>]` で suspect リストを取得する(読み取り専用・決定的)。signals: `stateless` | `stale-active` | `no-generated-at` | `progress-claim`。suspect がゼロなら「健全」と報告して終了する。
2. 各 suspect を**裏取り裁定**する。裁定ルール(本 skill の核):
   - **summary の自己申告(未実装/進行中/未了)より、コード・テスト・git 実績・チャット実績の裏取りが勝つ**。テストや実装が現に存在する/出荷済みなら、summary が「未実装」と書かれていても調査としては決着 = closed。
   - **残コード作業は Decision/Risk 側が持つ** — Investigation は「調査・focus の決着」で閉じる。コードが未完成でも、調査自体(何を試し何が分かったか)が終わっていれば closed でよい。
   - **真に継続中の focus は active のまま残す**(state 無しの suspect が実際にまだ動いている focus なら、state:"active" を明示して付与する — 棚卸しで見つけた宙ぶらりんを放置しない)。
   - **裏取りできず迷うものは閉じずに報告する**(勝手に閉じない)。判断材料が無い状態での state 変更は不可逆な情報ロストに繋がる。
3. 決着した分を**1 本の commit-mutation**(`op:update` で `state` のみ変更するプラン)にまとめて一括適用する。単発 1 件だけならその場で最小の plan で足りる。
4. 報告する(§親skill Reporting format 準拠):自然言語で、閉じた件数と根拠の要約 / active のまま残した focus / 保留とその理由、を簡潔に。ID / raw JSON はダンプしない。

## 不可侵

- **delete しない**。系譜保存が流儀 — closed はランキングで 0.6 倍減点され、検索結果の順位が自然に沈む(除外はされない)。
- **知識ノード(Decision/Risk/OK 等)の「まだ真か」には踏み込まない** — それは drift-reconciliation(`$REF/drift-reconciliation.md`)の領域。本 skill は Investigation の state だけを扱う。
