---
name: graphrag-checkpoint
version: 1.1.0
description: compact で消える前に、いま価値あるものを全部グラフへ吐き出す「最終フラッシュ」。長時間セッションで context が埋まってきた時、compact の盲目的要約に任せず狙って残す。「compact する前に退避して」「checkpoint 取って」「コンテキスト埋まってきたから状態を保存」「compact しても大丈夫なようにグラフに残して」で発火。人間が余力のある頃合いで手動発火する (自動検出はしない)。compact 後の復元は SessionStart フックが自動で行う (このskillは退避側)。スラッシュ: /graphrag-knowledge:graphrag-checkpoint
---

# Compact Checkpoint（退避・最終フラッシュ）

compact 直前に手動発火し、**A(作業状態の退避)と B(未書き戻し恒久知識の救出)を同格に**グラフへ吐き出す。read/write の土台・CLI 詳細は親 skill `graphrag-knowledge` と `$REF/`(= `${CLAUDE_PLUGIN_ROOT}/references`)に従う。`$CLI` = `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts`。

## 位置づけ（何をする skill で、何をしないか）

- これは **proactive-persistence を "compact 前" トリガで実行する**もの。既存の常時フラッシュ(commit 前 nudge 等)は据え置き。checkpoint はその**取りこぼしを掃討**する後段。
- **主戦場は常時フラッシュ**。checkpoint で拾えるのは発火時点で文脈に残っているものだけ — 100% 埋まった文脈の全ては残せない。**狙って残す**のが価値(compact の盲目的要約より上)。
- **発火は人間の手動のみ**。残 context 量の signal は存在せず「ちょうどいい頃合い」は自動判定できない。余力のある頃合いに人が撃つ。撃つ作業自体が context を食うので、**カツカツになる前に**撃つのが吉。
- **checkpoint は ctx 節約が本義**。退避・救出の各ステップ自体が context を食うため、本 skill 内の読みは最小で済ませる(B の重複確認の軽量化ルールは §B を参照)。
- **復元はこの skill の担当外**。SessionStart フック(`compact-restore.mjs`)が `brief --mode resume` を自動注入する。発火は compact 直後(常に)または clear 直後(手順 C の one-shot マーカーがあるとき — 消費されるまで有効、失効 60 分)。**checkpoint → `/clear` → 綺麗に再開** が盲目的要約ゼロで一番きれい。カツカツで auto-compact に飲まれても compact 側の復元が保険。

## 手順

### 0. preset 判定
`$CLI inspect` で vault type を確認 → system / project の該当 quickref だけ読む(§親skill Schema quick-ref)。救出先の語彙が変わる。

### A. 退避（作業状態 → active Investigation ＋ ConversationChunk）

1. `$CLI brief --mode resume` で**現 focus の active Investigation** を探す。
   - あれば **update**(focus が同じ間は1個を更新し続ける — op:update で `generated_at` が進み、復元時に最新として primary に来る)。
   - 無ければ **create**(`state: active`)。focus が途中で変わっていれば旧を `state: closed` にして新規(§親skill Focus continuity)。
2. その Investigation の **`raw_content` に作業状態を構造化テキストで**書く(commit-mutation の `updates`。※専用フィールドは作らない):
   - `current focus:` いま何をしているか(復元後の再起点の一文)
   - `next:` 次の具体アクション(再導出なしで再開できる粒度。済んだ枝は落とす)。**先頭は「一意な最初の一手」** — 復元直後のエージェントが迷わず着手できるよう、対象(file:line か実行コマンド)と期待結果まで具体化した 1 アクションを必ず先頭に置く。「〜を調べる」「〜まわりを整理」のような探索でしか始められない書き方は禁止(それが復元後の彷徨いと ctx 浪費の主因)。
   - `blocker:` 詰まり・未解決依存・待ち
   - `touched:` 編集中/対象ファイル(可能なら file:line と「何を変えようとしてるか」)
3. 深い生ログ(失敗した道 / 正確なコマンド / 非自明な発見 / このセッションでユーザが述べた制約 / 多段変更の途中状態)は **ConversationChunk** に、**固定 slug で update-in-place**(肥大回避・高価値片のみ)。`discussed_in` で Investigation へ繋ぐ。
4. **退避前セルフチェック**(work_state を書き込む前に自問):
   - next 先頭だけを読んで、探索なしで最初の編集/コマンドに入れるか?
   - current focus / next / touched の間で矛盾や古い記述が残っていないか(済んだ枝は落としたか)?
   - どちらかが No なら書き直してから退避する。曖昧な checkpoint は復元後に「やることを一意に絞れず探し回る」コストとして返ってくる。

### B. 救出（未書き戻しの恒久知識 → 既存の知識型・自動書き込み）

未書き戻しの恒久知識を**型別に一巡**して漏れを潰す。想起トリガはモデルの記憶が主(git diff は任意の補助 — commit タイミングと作業区切りはずれるので必須にしない)。

- **Decision**(代替から選んだ判断)
- **RejectedOption**(試して捨てた案 — **最も痕跡が残らない・最優先で拾う**)
- **Risk**(気づいた将来の脅威)
- **OperationalKnowledge**(運用のハマり・ワークアラウンド)
- project preset のみ: **Assumption**(置いた前提)/ **Agreement**(合意)

各候補について:
1. **重複確認は軽量に**。このセッション自身が生んだ知識(いま試して捨てた案、いま踏んだハマり)は既存とぶつかる見込みが薄いので **事前 ask を省略してよい** — write-time duplicate gate が suspect を返したら skip / update / `--dup-ack` で捌く(親 skill の「ask 前置確認」原則の、checkpoint に限った緩和。根拠: checkpoint は ctx 節約が本義で、型別 ask 連打は evidence 昇格で肥大しやすい)。既存知識の更新かもしれない候補(セッション前から在りそうな一般論)だけ `$CLI ask "<候補>" --limit 2` で確認する。
2. 無い物だけ **`add-*` / `commit-mutation` で自動書き込み**(承認を待たない。明確な物は即書き、真に境界的な物だけ報告で提示)。evidence に触ったファイルを `documented_by` で紐付け。
3. **この focus が生んだ知識は Investigation に繋ぐ**(復元時に文章だけでなく実ノードへ到達させるため):
   - **`derived_from`**(知識ノード → Investigation)を全 B ノードに張る(普遍的 provenance・両 preset 対応)。
   - Decision には加えて **`led_to`**(Investigation → Decision)。

**不可侵**: 計画/スケジュール型(**Task / Milestone / Resource / Stakeholder**)には**書かない**。project の Task はプロジェクト自体の計画であって、このチャット作業の産物を流し込む先ではない。

### C. マーカー（/clear 復元の意図表明・必須の締め）

書き込みが終わったら **`$CLI checkpoint-mark`** を撃つ(任意で `--focus "<一行>"`)。これが SessionStart フックへの「/clear されたら復元せよ」という **one-shot の意図表明**になる:

- フックは clear 時にマーカーを見つけたら**消費(削除)して復元**する。壁時計に依存しないので、checkpoint 後に報告を読んだり会話してから `/clear` しても取りこぼさない。
- 暴発防止に失効 60 分あり。撃ったのに `/clear` しなかった古い意図は、次の clear/compact で黙って片付く。
- **撃ち忘れると** clear 復元は旧ゲート(Investigation の `generated_at` が 10 分以内)に落ち、内容が変わらない再 checkpoint では `generated_at` が進まないため取りこぼしやすい。C は省略しない。

## 報告（ユーザ向け）

自然言語で:退避した focus / **next 先頭の一手(一文で)** / 次アクション件数 / 詰まり、救出で**何を書いたか・何は既存でスキップ・何は判断保留**、を簡潔に。「マーカー済み — `/clear` してOK(60 分以内)」で締める。ID / raw JSON はダンプしない(§親skill Reporting format)。

## 一括適用のヒント

A と B は独立ノード群だが、**1本の `commit-mutation` プラン**にまとめられる(Investigation update + ConversationChunk + 新規知識ノード + `discussed_in`/`derived_from`/`led_to` エッジ)。テンプレートは `$REF/mutation-templates.md`。単発の知識1件だけなら typed-add(`add-*`)で足りる。C の `checkpoint-mark` はプランに入らない独立 verb — 最後に 1 回だけ撃つ。
