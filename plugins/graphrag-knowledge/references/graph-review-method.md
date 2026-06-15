# グラフを使ったレビューの共通メソッド

`/graphrag-knowledge:graphrag-design-review` / `:graphrag-pr-review` / `:graphrag-review-doc` の3 skill が共有する土台。
3つは別物に見えて、根は同じ **「変更（または提案）を起点にグラフを逆引きし、概念高度で人間の枠と照合する」**。
違いは入力軸と出力形だけ:

| skill | 入力軸 | タイミング | 出力 |
|---|---|---|---|
| graphrag-design-review | 設計案・approach（知識軸 = 実装前面） | plan / 設計時 | 助言（概念高度の所見） |
| graphrag-pr-review | 変更 diff（横断軸 + File = 実装後面） | PR / diff 時 | findings（3段で分類） |
| graphrag-review-doc | 変更 diff（同上） | PR レビュー前 | 人間向け説明文書（HTML） |

> ※ 本 reference の節番号（§0〜§5、枝番 §1.5 / §2.5 含む）は上記3 skill の SKILL.md から参照される。節を追加/削除/並べ替えた時は参照元（各 skill の「method §N」表記）も合わせて更新すること。

pr-review と review-doc は **ほぼ同じパイプライン**（逆引き → 順引き網羅 → 概念デルタ）。出力が findings か文書かの差。
design-review だけ読む軸が知識軸（Goal/Decision/Constraint/Risk）に寄る。

---

## 0. 大前提（この3コマンド共通の不変条件）

これは vault に記録された設計（`ask "グラフを使った PR レビュー層の目的"` で引ける）に従う:

1. **目的は QA でなくコントローラビリティ**。バグ検出は AI が diff レベルで人間に勝るので、ここで bug を探すのが主目的ではない。狙いは「大枠おまかせ、でも枠は超えるな」——人間が所有する概念層（知識軸 + 横断軸 Stratum/Vein/Pocket）の意図を、コードが崩していないかを見る。
2. **hard reject しない**。グラフ vs コードの乖離は、グラフが古いのかコードが間違いか機械が決め打てない。だから**拒否でなく可視化**。直す責任（fix 方向の裁定）は人間が取る。
3. **explanation-first**。第一の仕事は「違反リスト」でなく「概念高度の説明」。違反は説明文書の中の概念デルタ注釈として出す。
4. **traceable**。所見・主張は必ず人間承認済みの知識ノード（source backing 付き）まで辿れること。AI の自由作文に裁可印を押させない。所見には必ず根拠ノードの id を添える。
5. **grep しない**。「どの概念・経緯・罠・方針があるか」は `ask` / `evidence` で引く。`vault/*.md` も `graphrag/*.ts` も直接読まない（SKILL.md の Anti-patterns 準拠）。
   これは**知識の取得経路**の話であって、**レビュー対象コード（diff・候補 File）を読むことはむしろ義務**（§2.5-3）。
   グラフ内だけで所見を結論づけるのは、うわべのレビューになるので禁止。

---

## 1. CLI の呼び方（全コマンド共通）

```sh
node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts <verb> [args]
```

リポを直接 clone した dev 環境では `${CLAUDE_PLUGIN_ROOT}` が無いので、リポ root で
`node --experimental-strip-types graphrag/cli.ts <verb>` と相対で叩く。

使う verb:
- `ask "<質問>"` — 概念・経緯・罠・方針を1発で引く（brief→evidence 自動段上げ）。**連打しない**。
- `evidence --request "<タイトル/パス>" [--types T] [--limit N] [--neighbors N]` — 特定ノードの周辺（governance・派生）を辿る。
  **id では引けない**（id は検索対象から除外されている）。direct_evidence の id / type で対象ノードを確認してから graph_context を読む。
  `match_confidence` が low/none の結果は採用しない。
- `carving-check --graph <path> [--vector-index <path>]` — 構造ゲート。特に **#9 knowledge-impl-binding-missing**（方針が実装に紐付いていない）を見る。
- `edge-suggest-policy` — Decision/Constraint/Risk → File の `sets_policy_for` 候補を機械抽出（binding 補完用）。

---

## 1.5 鮮度プリチェック（逆引きを始める前に）

逆引き（§2）は「変更 File がグラフに載っている」ことを暗黙の前提にしている。索引が diff に追いついていないと、
以降の全手順が静かに空振りする。だから**逆引きを始める前に**、diff 内の各 File がグラフに存在するかを確認する:

1. `evidence --request "<変更Fileのpath>" --types File --limit 1` で各変更 File を引く（§2.5-1 の影響圏展開と同じ呼び方なので二度手間にならない）。
2. **グラフに存在しない File があった場合**: 「グラフがこの diff を知らない（索引が古い）。先に増分 index / carve を回すか、
   この File 群はレビューの盲点として冒頭に明記」を**所見の冒頭**に出す。黙ってスキップしない。

§4 の binding 漏れとは**原因が違う**: §4 は「File はグラフに在るが統べる方針が紐付いていない」（紐付け漏れ →
処方は `edge-suggest-policy` での bind 補完）、ここは「File 自体がグラフに無い」（索引遅れ → 処方は増分 index/carve）。
混同すると間違った処方を案内する。

---

## 2. 逆引きの骨格（pr-review / review-doc の共通手順）

変更 File 群を入力に、グラフから「枠」を組み立てる:

1. **変更 File を取る**: `git diff --name-only <base>...<head>`（または現在の作業差分）。
2. **着地点の逆引き**（横断軸）: 各変更 File が **どの Stratum（層）/ Pocket（塊）/ Vein（脈）** に属するかを `ask` / `evidence` で引く。
   - 「UI Layer に変更が入った」等のルーティング信号はここで出る（変更 File → interface/画面層 Stratum や UI Pocket）。
3. **governance の逆引き**（知識軸）: その File / 塊 / 層 / 脈を **統べる Decision / Constraint / Risk / OperationalKnowledge** を引く
   （`sets_policy_for` / `constrains` / `risks_in` / `documented_by` の逆方向）。
   = 「この領域は何の方針・制約・リスクに縛られているか」。
4. **過去経緯**: 関連する **RejectedOption（却下案）** と `supersedes` 連鎖、`Investigation -led_to-> Decision` を引く。
   = 「ここで何が既に却下され、どの判断がどう生まれたか」。
5. **現役末端の確認（state）**: 引けたノードの `supersedes` / `refines` 連鎖と state を確認し、**現役末端で枠を組む**。
   **state が superseded の Decision を基準点にしない**（後継は `refines` の逆引きで辿る。retrieval も終端 state
   superseded/closed/abandoned/achieved を減点して返すが、除外はしない — 末端の選択はここで自分でやる）。

この5ステップで得た「枠」が、説明文書の骨格であり、概念デルタ判定の基準になる。

### 指示文 ↔ スキーマ 対応（人間の概念語をグラフ要素へ）

| 概念語 | グラフの担い手 |
|---|---|
| レイヤー | Stratum |
| コンポーネント | Pocket |
| 機能グループ | Vein |
| 課題 | その領域に `risks_in` する Risk / 緊張中の Constraint / 未達 Goal |
| 罠 | Risk + OperationalKnowledge |
| 方針 | Decision + Constraint（`sets_policy_for` / `constrains`） |
| 過去経緯 | RejectedOption + `supersedes` 連鎖 + Investigation `led_to` |

---

## 2.5 順引き＝影響圏の展開（"影響あるはずなのに diff に無い File" の検出）

逆引き（§2）は「変更 File → 枠」の片道。グラフの本懐は**影響範囲の芋づる・網羅**なので、ここで折り返して
**枠 → File 集合 → diff との突き合わせ**を行う。これをやらないと「変更が枠を超えていないか」しか見えず、
**「枠の中で触るべき同胞を触り損ねていないか」（変更の不完全性）**が漏れる。

1. **影響圏の展開**: 変更 File を seed に `evidence --request "<変更Fileのpath>" --types File --limit 1 --neighbors 2` で引く。
   **neighbors は 2 が必須**（depth1 = 所属 Vein/Pocket/Stratum と File 直宛の方針エッジ、depth2 = 同胞 File。1 では同胞まで届かない）。
   seed は `--types File --limit 1` で変更 File に固定する（曖昧 match だと無関係ノードの近傍が影響圏に混入する）。
   近傍展開は接する全エッジを**向き両方**で返すので網羅は機械保証される（depth を跨ぐ重複辺は dedupe して数える）。
   `match_confidence` が low/none なら graph_context を影響圏として採用しない（代替キーワード1回 → だめなら §4 の binding 漏れ扱い）。
   読むもの:
   - 所属 **Vein / Pocket / Stratum** の `evidenced_by` File 群（depth2）= 同じ脈・塊・層の同胞 File。
   - 統べる **Decision / Constraint / Risk** の `sets_policy_for` / `constrains` / `risks_in` の他の宛先。
     宛先が横断構造（`sets_policy_for` / `risks_in` のみ。**`constrains` の宛先は File 単位限定**）なら `evidenced_by` でもう1段展開（芋づる）。
2. **突き合わせ**: 展開した File 集合 − 変更 File 集合 = **影響圏内なのに diff に無い File 候補**。
3. **候補の裏取り（必須・グラフ内で結論づけない）**: 各候補 File について、所見化するにも落とすにも先にこれを通す:
   - **候補を統べる governance を引く**: `evidence --request "<候補のpath>" --types File --limit 1 --neighbors 1`。
     この per-候補引きは**低高度 bind（File 直宛の Constraint / 方針エッジ）への唯一の到達経路として無条件必須**。
     将来 `constrains` の宛先が拡張されても消えない手順（**この手順の削除は禁止**）。
   - **候補 File と diff の該当箇所を実際に読む**。グラフは「どこを見るべきか」の芋づる索引であって判定材料ではない。
     読まずに「影響の有無を要確認」で済ませるのは禁止（§0-5 の grep 禁止は「概念・経緯を vault から引く時」の話。
     レビュー対象コードを読むのは義務）。
   - **二つの問いを必ず両方立てる**（変更形に依存しない形で問う。「同じ手当て」の語に引っ張られない —
     修正の横展開だけでなく、リネーム・形式変更への追従や規範自体の変更への適合も同じ問いで拾う）:
     - **取り残し**: この変更の後、候補は**規範・変更側と整合したままか**
       （同じ手当て・追従・新しくなった規範への適合が要るのに、置き去りになっていないか）。
     - **前提崩し**: 候補は変更不要でも、**候補を統べる規範・制約の前提をこの変更が崩していないか**
       （例: 検証層を迂回する呼び出しパスの新設、エラー処理の素通り）。
     どちらも「整合している」と確認できて初めて候補を落とせる（「同じ手当ては不要」だけでは落とせない）。
4. **経路付きで選別**: 候補を機械的に全列挙しない（ノイズはレビューを儀式化させる）。裏取り（3）を通過した上で、
   所見にする候補には**伝播経路**（変更 File → 共属ノード → 候補 File）と読んだ根拠を添える。
   例: エラー処理 Vein の規範に関わる変更が、脈に属する 3 File 中 1 File にしか触れていない → 残り 2 File を読み、
   リトライ欠落を確認して経路付きで提示。
5. **強制度は advisory 既定、ただし重大なら格上げして騒ぐ**（§3 の表と格上げ規則）: 集合差そのものは機械的でも
   「影響が実在するか」は意味判断なので、既定では止めない。だが**段は上限ではない**。裏取りの結果
   「未変更側が規範を破る・前提が崩れる」と言える場合
   （例: エラー処理 Vein の規範変更が片方のパスにしか入っていない / Constraint の前提を崩してセキュリティが緩む）は、
   それは触り残しの形をした **Constraint / 規範違反**なので **ACK 必須に格上げ**し、冒頭の赤帯で騒ぐ。
   さらに規範ノードが無くても「これは欠陥（壊れる・穴が開く）」と高い確信で言える触り残しは黙らせない —
   赤帯に**「グラフ外所見」と明示**して出す（traceable 原則の例外であることを隠さずに騒ぐ）。
6. **会計**: 出力の網羅チェック節（独立セクション）には、枠ノードごとに
   「展開した File 数 / 裏取りした候補数 / 落とした候補とその理由」を 1 行ずつ記す。
   **「該当なし」は会計付きでしか書けない**（展開作業ゼロで「無し」と書くのを構造的に塞ぐ）。

### 裏取りの subagent 並列委譲（実行手段の追加であって義務の縮小ではない）

候補が多い時、裏取り（3）の読みを subagent に並列委譲してよい。ただし:

- **委譲ペイロードに必ず同梱する**: ① 該当 diff hunk の**全文**、② 候補を統べる規範ノードの summary、
  ③ 二つの問い（取り残し / 前提崩し）の**原文**。要約で渡さない（要約の劣化が裏取りの劣化に直結する）。
- **判定は委譲しない**: subagent の返答形式は「候補コードの該当箇所の引用 + 観測事実 + 根拠ノード id」に限定する。
  整合/不整合の判定と所見への統合はメイン文脈で行う。
- **subagent への必須記載**: `add-*` / `commit-mutation` による書き込み禁止、`vault/*.md` の直 grep 禁止
  （SKILL.md の Anti-patterns を継承させる）。
- 委譲は裏取りの**実行手段の追加**であって裏取り義務の縮小ではない。委譲しても**全件二択（取り残し/前提崩し）と
  会計義務（6）は不変**。

⚠ この検出力は横断ノードの `evidenced_by` / 方針エッジの張られ具合に比例する。候補が一件も出ない時は
「影響圏が空」と即断せず、binding 漏れ（§4）の可能性をまず疑うこと。

---

## 3. 概念デルタの判定（pr-review の中核 / review-doc の注釈源）

逆引きで得た「枠」に対し、変更が枠を超えていないかを見る。観点:

- **却下案の再導入**: 変更が、過去 RejectedOption と同じ approach を蘇らせていないか（名前・要旨の一致）。
- **層破り（Stratum）**: 変更後の import が依存の縦位置を逆走していないか（下位が上位に依存）。
- **Decision の暗黙の反故**: その領域を統べる Decision の意図を、明示せず崩していないか。
- **Vein の滲み出し / 規範 vs 実体**: 横断ノードの summary（= 規範・設計意図）に対し、変更後の実体（evidenced_by）がズレていないか。
  例: エラー処理 Vein の規範が「ユーザーに出す + リトライ」なのに、新パスが log だけ → Vein から外れている。
- **governance 違反**: 変更が、その領域の Constraint / 確立済み方針を満たしているか。
  例: 「エラーはユーザーに出す（失敗N件 UI）」「リトライ機構がある」方針の領域で、catch+log だけの追加 → 方針退行。
- **scope creep**: どの Goal にも紐づかない変更（向かう先に対し遠回り/逆行していないか）。
- **has_premise 逆引き（前提崩れの波及）**: 変更が反故/supersede する Decision に `has_premise` している**現役ノード**を
  逆引きで列挙する。旧ノードへの has_premise 流入エッジは系譜保存でそのまま生きる — だからこそ「前提が崩れたまま
  生き残るノード」を明示的に列挙しないと波及が見えない。
- **reduces_risk の解除**: 変更が弱める/反故にする Decision が `reduces_risk` していた Risk は**再開する**。
  抑えが外れた Risk を所見として出す。
- **OperationalKnowledge の再踏み**: 既知のハマり・ワークアラウンド（OperationalKnowledge）を変更が無効化していないか、
  過去に踏んだ穴を再導入していないか。
- **carving.json の免除追加**: diff に `.graphrag/carving.json` の変更が含まれる場合、**免除追加を findings に昇格して
  人間裁定**に回す（carving.json は Stratum/Vein/Pocket と同格の人間所有の概念層。LLM は提案のみ可で、追記は user 承認後）。
- **観点リスト外の概念デルタ**: 上のどれにも当てはまらない概念レベルのズレに気付いたら黙殺しない —
  「グラフ外所見」と同じ作法（出自を明示して出す。下記格上げ規則参照）で明示して出す。

### 3段の強制度（findings の分類）

| 段 | 何が該当するか | 振る舞い |
|---|---|---|
| **ERROR** | グラフ内部整合の崩れ（型ペア違反等）。`carving-check` / `validateGraph` 領域 | （レビューでは稀）構造として拒否 |
| **ACK 必須** | 機械が高精度に乖離を検出できるが fix 方向は人裁定: **却下案再導入・層破り・Constraint 違反**。＋重大度で格上げされた所見（下記） | 拒否しないが**止めて承認を促す**（赤バナー） |
| **advisory** | LLM 判断系: Vein 滲み出し・Decision 暗黙の反故・governance 退行・scope creep・**影響圏の触り残し（§2.5 網羅チェック）** | 表示のみ（文脈中の言及。網羅チェックは独立セクション） |

**段は検出経路ごとの既定値であって上限ではない（格上げ可・格下げ不可）**: advisory 帯の所見でも、統べる
Constraint / Vein 規範 / Risk と交差して「実害が出る（壊れる・穴が開く・前提が崩れる）」と判断できるなら
**ACK 必須へ格上げ**して赤帯で騒ぐ。規範ノードが無い純粋な欠陥所見も黙殺せず、赤帯に「グラフ外所見」と
明示して出す（traceable 原則の例外を隠さない）。hard reject しない原則（§0-2）は格上げ後も変わらない —
騒ぐのは「止めて確認」までで、直す方向の裁定は人間に残す。

**この種の方針退行（エラー可視化の例）は advisory 帯**。意味判断であり、catch ブロックという File 以下の粒度なので機械 stop にはならない。だが説明文書に方針を並べることで、人間（とレビューする LLM）の目に確実に入れる。

---

## 4. 前提が満たされているかの自己点検（重要）

逆引き（手順2-3）で **その領域を統べる知識ノードが1つも出てこなかった場合**、それは「枠が無い」のではなく
**「枠が領域に bind されていない」可能性が高い**（= `carving-check` #9 knowledge-impl-binding-missing）。
方針が vault に在っても実装 File に `sets_policy_for` / `constrains` で繋がっていなければ逆引きで出ない＝レビューで漏れる。

- この状態を検出したら、所見に **「この領域には統べる方針が graph 上に無い（binding 漏れの疑い）。`edge-suggest-policy` で候補を引き、方針を bind すれば次回から拾える」** と明記する。
- 黙って「方針なし」と結論しない。silent な binding 漏れこそが、過去に方針退行が漏れた本質（vault 記録の回帰 case 参照: `ask "エラー可視化の退行"`）。

---

## 5. 出力の作法

- **所見には必ず根拠ノード id を添える**（traceable 原則）。例: `⚠ [advisory] エラー可視化方針の退行の疑い（constraint:...:errors-surface-to-user）`。
- **段で目立ち方を変える**: ACK 必須は冒頭にまとめて目立たせ、advisory は該当箇所に添える。
- **断定しない裁定**: 「枠を超えている可能性。直すのはコードか、それとも方針（グラフ）側を更新して意図変更を承認するか、は人間が決める」と、fix 方向の選択を人間に残す。
- **解決の書き戻し（レビューの狼少年化を防ぐ）**: ACK 必須所見を人間が「意図変更を承認」で解決した場合、
  承認された意図変更を mutation として提案する — Decision の update（state 更新等）、方針転換レシピ
  （新 Decision を作り `refines` で旧に張り、旧を state superseded に更新。反転で捨てた案が再誘惑されうるなら
  RejectedOption を併設）、または新 RejectedOption — そして graphrag-knowledge skill の書き戻しへ繋ぐ。
  **グラフを更新しないと次回レビューでも同じ所見が再発し、ACK が儀式化する（レビューの狼少年化）**。
  承認で終わらせず、グラフ側を承認後の現実に追従させて初めて解決と呼べる。
