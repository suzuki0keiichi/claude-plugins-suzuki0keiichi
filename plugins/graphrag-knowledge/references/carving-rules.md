# 概念 carving 品質ルール

`conceptual-pass.md` が「何を」「どのエッジで繋ぐか」を規定するのに対し、本ファイルは
「どう切るか」「どう仕上げるか」の品質ガードを規定する。Pocket / Vein / Stratum を
mutation する全ての conceptual-pass で本ルールを満たすこと。違反は `validateGraph` を
通っても carving 不良で、retrieval 品質と将来の追従性を直接傷つける。

> 軸2(横断構造)のノード型は地質メタファーが canonical: **Pocket(鉱塊)= 局所に凝集
> した構造的まとまり**(旧 `Component`)、**Stratum(地層)= 水平に積もるアーキ層**
> (旧 `Layer`)、**Vein(鉱脈)= 層を貫いて走る横断的関心**(旧 `Concern`)。旧 engineering
> 名は alias として互換に残る。本ファイルは canonical 名で記述する。

## なぜ品質ルールが要るか(設計判断の背景)

`indexer-redesign-notes.md` の最終結論: retrieval 品質の天井はモデル能力ではなく
「解釈ガイダンス + グラフ信号 (role) の活用」だった。同じことが carving にも当てはまる。
indexer が出す候補(依存コミュニティ・トポロジ深さ・命名)は決定論的足場で、最終的に
何を Pocket / Vein / Stratum と命名するかは LLM の判断。判断軸が無いと、

- 関連語が引きずられて mega-pocket(38ファイルが1つ等)が生まれる。
- 横断意図と局所責務が同じ概念で二重表現される(`Pocket` と `Vein` の重複)。
- 番号採番が残って意味スラグが付かない(`c1`〜`c9` 採番、欠番事故)。
- 新規ディレクトリ追加時に追従漏れが起きる(`core/backup/` などの孤児化)。

これらは事後で見つけても、再 carving しないと直らない。carving 段階で品質ゲートに
通すのが最も安価。

## Pocket carving

### 同ディレクトリ原則(default)

候補 Pocket のメンバー File が同一ディレクトリから集まっている場合は、原則そのまま
1 Pocket として確定する。`evidenced_by` の根拠もディレクトリ単位で揃う。

異なるディレクトリの File を同じ Pocket にまとめる場合、Pocket の `summary` に
**「なぜ束ねるか」の justification を 1 文必ず入れる**:

- 良い例: 「`core/cloud/` の I/O 群と `server/routes/network` の HTTP 受け口を共に
  Web.Auto への外向き接続として束ねる」。
- 悪い例: justification 無しで `core/cloud/` と `core/pipeline/` と `core/scanner/` を
  「I/O 系」とまとめる(=異なる責務を一括りにしている兆候)。

justification を書こうとして詰まる場合は、それは束ねるべきでない兆候。割る。

### 粒度ガード

| 状況 | 対応 |
|---|---|
| 4 ファイル未満 | ほぼ「箱」状態。Vein との二重表現や、より大きい Pocket に吸収できないか再評価 |
| 4〜20 ファイル | 標準粒度。そのまま確定 |
| 20 ファイル超 (テスト含む) | 責務が複数混入している可能性。機能軸で分割の検討必須 |
| 30 ファイル超 | ほぼ確実に複数 Pocket の合成。分割しないなら `summary` に強い justification |

粒度は「ファイル数」ではなく「責務の凝集」で判断する。ファイル数はあくまで再評価の
トリガー閾値。

### 異物検査(必須)

Pocket の `title` / `summary` が示す責務に対し、メンバー File の **path / ファイル名から
明らかに無関係なもの**を混ぜない。検査手順:

1. Pocket の `title` を読む。
2. 各メンバー File の path 第 1〜2 階層を見る(例: `core/pipeline/`, `core/scanner/`)。
3. その path が `title` が示すドメインから外れているなら、別 Pocket へ移す。
4. 「`core/` 直下の `logger.ts` / `utils.ts`」のような汎用ファイルは、どの Pocket にも
   属さないものとして allowed-orphan 扱い(網羅性ゲートで除外、後述)。

良い例: `title=「クラウド I/O」` のメンバーが `core/cloud/*`, `server/cloud-endpoints.ts`,
`server/routes/network.ts`, `server/routes/settings.ts` で揃っている。

悪い例: 同じ Pocket に `core/pipeline/compress-worker.ts` や `core/scanner/rosbag-info.ts`
が混入。これらは path から明らかに別ドメイン。

### 1 file 責務の扱い (吸収 / 1-file Pocket / allowed-orphan の判定フロー)

「同ディレクトリに 1 file しか無い責務」 や 「孤立した汎用/定数/型 file」 が出てきた時の判定。
**乱造防止のため、 上から順に試して**、 早く決まった段で確定する。 LLM は step 4 を
回避しようとして「とりあえず作る」 をしないこと (= 強い意志で止める)。

```
1. 既存 Pocket に「同ドメイン narrative」 で吸収できるか?
   = 既存 Pocket の title/summary を書き換えずに、 この file を含めても整合するか?
   YES → 既存 Pocket に `evidenced_by` 追加 (吸収)。 【最優先】

   例: `core/backup/backup-manager.ts` 1 file は、 既存 `device-pipeline` Pocket の
       narrative (「device 検出 → scan → backup/compress/upload pipeline」) に整合する
       なら吸収する。 単独で 1-file Pocket を切る前に必ず試す。

2. 1 file でも独自の **ドメイン narrative が書けるか?**
   = title + summary を「この file は何の責務を持つか」 で 1 文で書け、
     既存 Pocket と重複せず、 将来同ドメインの file が追加されたらここに集まると言えるか?
   YES → 1-file Pocket を新規作成して良い。 (= 網羅性のため 1 file Pocket を許す)

   良い例: `luks-manager.ts` 1 file → title=「LUKS パーティションのアンロック管理」、
           将来 `unlock-luks` 系拡張があればここに集まる、 narrative 成立。
   悪い例: `string-helper.ts` 1 file → title=「文字列 helper」 で narrative 弱い
           → 1-file Pocket にせず step 3 へ。

3. 上記いずれも当たらない共通インフラ (constants / types / composition root /
   汎用 utility) または、 それらの test か?
   YES → **allowed-orphan として残すことを許可** (orphan で構わない)。
         ただし、 「step 1 で吸収できるなら吸収優先」 の原則は変わらない。
         allowed-orphan は「orphan のまま許す」 であって「強制 orphan」 ではない。

   例: `server/index.ts` は composition root だが、 narrative が「Express サーバと
       API ルート」 Pocket に整合するなら吸収 (step 1) を選んで良い。
       逆に narrative が複数 Pocket を跨ぐ束ね役なら allowed-orphan で残す。

4. どれも当たらない / 迷う
   → **STOP**。 新規作成しない。 user に判断を上げる。
     「これは Pocket ではない」 と「新規 Pocket 化が妥当」 の判断は user 側で
     強い意志を持って決める。 LLM は「迷ったら作る」 にならないように止める。
```

### 定数 file の取り扱い (思想)

`constants.ts` / `enums.ts` のような **定数だけを集める file は新規作成を避ける**。
定数は使用する domain file 内に直接書くこと (= ドメイン凝集を優先)。

歴史的 / 共有目的の理由で既に存在する `shared/constants.ts` 等は allowed-orphan で
許容するが、 これらは「やむを得ない fallback」 であって望ましい状態ではない。
新規追加コードで定数 file を作ろうとしたら、 まず「ドメイン file 内に書けないか」 を
検討する。

### 意味ある命名 必須(Pocket / Stratum / Vein 共通・プレースホルダ禁止)

**この規則は3つの crosscut 型すべて(Pocket / Stratum / Vein)に等しく適用する。** indexer は
候補に機械プレースホルダの id・title・summary を付ける(`pocket:<sys>:c1` /
`stratum:<sys>:band0` / title `"Stratum band 0/3 (41 files)"` / `"Pocket candidate c1"` 等)。
これらは**メンバーの構成要素(束ねた File 群・依存深さ帯・連番)であって意味ではない**(§0 大原則)。
carve とは、この機械名を**「そのノードが何を担うか」の意味命名に置き換える**こと。

**id slug — 必ず意味の kebab-case。**
- 良い: `pocket:<sys>:cloud-io` / `stratum:<sys>:foundation` / `stratum:<sys>:domain-logic` /
  `vein:<sys>:auth-access`
- 禁止: `c1` / `c2` …(Pocket 連番)、`band0` / `band1` …(Stratum 連番)。indexer の機械 ID は
  永続化前に必ず意味 slug にリネームする。

**title — 必ず意味の語。機械プレースホルダの痕跡を残さない。**
- 良い (Stratum): `基盤層 — 設定・データ・共有型の土台` / `入口・合成層 — 起動とルーティング合成`
- 良い (Pocket): `サーバ中核(設定/DB/認証/WS)` / `共有UI部品`
- **禁止(そのまま確定させない)**: `Stratum band 0/3 (41 files)` / `Pocket candidate c1` /
  `(7 files)` のような **依存深さ帯・候補連番・ファイル数を含む title**。ファイル数や band 番号は
  構成要素であって、その層/塊が「何を担うか」を一切表さない。

理由: 連番は将来の追加・削除で欠番事故(`c6` だけ消えて意味不明)を起こす。ファイル数・band
番号入りの名前は retrieval で意味の手掛かりにならず、メンバーが1つ増減しただけで名前が嘘になる。
意味命名なら衝突せず、削除しても履歴上意味が残り、検索でも効く。

**ゲートで強制**: `carving-check` は candidate:true 残存を `candidate-uncarved` ERROR、title の
プレースホルダ痕跡(`band N/M` / `(N files)` / `candidate cN`)を `placeholder-title` ERROR で
止める。連番 slug は `meaningful-slug` WARN。**carve 完了 = これらが 0 になった状態**。

### Constraint の Decision ロンダリング禁止

広域スコープの不変条件を Decision として書いて `sets_policy_for` で横断に張る偽装
(= Constraint の Decision ロンダリング)をしない。横断高度の constrains は文法に無い。
高度が無い場合は File 列挙 + 範囲を summary に明記する。

理由: Constraint は「破ってはならない不変条件」、Decision は「選んだ判断(supersede 可能)」で
意味論が違う。型を偽装すると、retrieval で「守るべき制約」を引いた時に漏れ、方針転換レシピ
(supersede)の対象に誤って乗る。命名と同じく、型もそのノードの**意味**を担う。

### 廃止と命名安定性

確定した slug は削除して空けない。廃止する Pocket は

- `op:"delete"` で消すなら、後継 Pocket の `summary` に「`<旧 slug>` を吸収」と書く。
- 名前を変えるだけなら、新規作成 + 旧 `op:"delete"` ではなく、可能な限り `op:"update"`
  で `title` / `summary` のみ patch する(slug 含む id は immutable のため、命名変更が
  本当に必要なら新規作成 + 旧削除になるが、その場合は履歴を summary に残す)。

**知識ノード(Decision / OperationalKnowledge)の廃止は削除でなく state**。方針転換した
Decision は消さず、方針転換レシピに従う: 新 Decision を作成 → `refines`(新→旧)を張る →
旧 Decision を `op:"update"` で `state:"superseded"`。反転で捨てたアプローチが再誘惑され
うる場合のみ RejectedOption を新設し 新Decision -`supersedes`-> それ を併設する
(supersedes の宛先は RejectedOption 専用のまま変えない)。旧ノードへの `has_premise`
流入エッジはそのまま生かす(系譜保存)。retrieval は superseded を除外せずスコアを
0.6 倍に減点して出す(hard reject しない)。手順の詳細は SKILL.md のスキーマ早見 /
`mutation-templates.md`。

## Vein carving

### Pocket / Stratum との質的違い

Pocket は依存コミュニティ、Stratum はトポロジ深さ帯 — どちらも indexer が決定論で
候補を出し、LLM は命名と意味付けを担う。候補を処理すれば結果が出る。

**Vein にはこの足場が無い。** 認証・観測性・エラー処理・暗号化・i18n・自動更新 —
これらは import グラフの中に「横断関心クラスタ」として浮かんでこない。Vein の
発見と定義は **LLM が概念的にモデリングする行為が主役**であり、carving 全体の
中で最も創発的な理解力が問われるステップ。Pocket / Stratum と同じ感覚で
「候補を処理して名前を付ける」アプローチでは、本来あるべき横断関心の多くを
見落とす。

Vein carving は以下の順序で行う: まず LLM が全体像から横断関心をモデリングし、
次に機械シグナルで盲点を補い、最後に品質ルールで仕上げる。

### LLM によるモデリング（主）

Pocket / Stratum で構造が見えた段階で、コードベース全体を俯瞰し次の問いを立てる:

- **このシステムの性質から、どのような横断的な関心が走っているか。**
  ドメイン固有の横断関心 (金融なら監査証跡、医療なら PHI アクセス制御 等) と、
  ソフトウェア一般の横断パターン (認証/認可・観測性・エラーハンドリング・設定管理・
  暗号化・i18n・自動更新 等) の両面から見る。
- **既存の Pocket / Stratum の間を貫いている共通の動機は何か。**
  複数の Pocket に同じ「なぜ」が散らばっている場合、それは Vein。
- **特定の技術スタックに偏らず、機能的な意味で横断しているものは何か。**
  例: LUKS は TypeScript / Express / React / Bash / systemd / udev と 6 技術
  スタックを跨ぐ — import グラフにも embedding 近接にも現れないが、
  「データ暗号化」という動機で横断している。path / ファイル名のテーマ語が手掛かり。

### 機械ヒントでの盲点チェック（補助）

LLM のモデリング後、下記の機械シグナルと突き合わせて見落としを拾う。
**これらは起点ではなく検算**。機械が出さなかった横断関心が存在しないとは限らない。

**`vein-hint`（embedding 近接クラスタリング）**: 各 File の embedding で k-NN graph
を構築し、異 Pocket 所属の意味的近接ファイル群を Union-Find でクラスタ化。
各クラスタを candidate JSON (member_files / spanning_components / theme_words)
として提示する。LLM のモデリングに含まれていない candidate があれば再考する。
推奨パラメータ: `--threshold 0.92 --knn 1 --min-cluster 3 --min-span 2`
(giant component 抑制のため k-NN graph を採用、threshold が低いと連結爆発する)。

**`cross_component_in_degree`（構造シグナル）**: 各 File に「自分を import して
いる distinct Pocket の数」が付与される。2 以上のファイルは縦串が走っている可能性。
例: `core/logger.ts` が 4 Pocket から import → 観測性 Vein の縦串。ただし
共通型 (`shared/types.ts`) や composition root も高 in-degree になるので、
機械シグナルだけで Vein と決めつけない。

### 横断条件 (≧2 Pocket)

`Vein` は **2 つ以上の Pocket にまたがって File を持つ**ものだけを立てる。

1 Pocket 内で完結する責務は Vein にしない。その Pocket の責務として吸収する。

判定手順:

1. 候補 Vein のメンバー File を取る。
2. それぞれが所属する Pocket を集計する。
3. Pocket が 1 つだけ → Vein にせず、その Pocket の `summary` で言及する。
4. Pocket が 2 つ以上 → 横断意図として Vein に昇格。

例: 「i18n の React 辞書 (`src/ui/i18n/*`)」だけなら UI 系 Pocket の責務。
Windows installer 側 (`packaging/windows-installer/workflow/install-messages.ps1`,
`msi-maintenance-notice.vbs`) まで横断するなら Vein。前者だけで Vein + Pocket
の二重表現にしない。

### Vein の命名指針 (1 段抽象)

機能名そのまま (例: `luks-encryption`) ではなく **1 段抽象化した概念名**を優先する。

- 良い例: `data-encryption` (LUKS と config crypto を統合)、`auto-update` (MSI と
  WSL distro 更新を統合)、`observability` (log + sentry + ui-trace)
- 悪い例: `luks-management`、`msi-self-update` (具象に張り付いて将来の追加で再命名が要る)

理由: Vein は「動機」を表すノードで、特定実装の名前を背負うと、別実装の同動機
ファイル (例: AES 暗号化が追加された時、LUKS Vein には入らない) が浮く。
抽象語にしておけば「同じ動機の新規実装」を後から吸収できる。

ただし過度な抽象 (`security`, `infrastructure` 等) は単一動機原則 を破る (security の
中に秘匿・暗号化・検証・権限が混入) のでダメ。**1 段抽象**が目安。

### 単一動機原則

**1 Vein = 1 動機**。複数の動機を束ねた "セキュリティ" / "信頼性" 等の総称 Vein は
作らない。動機を辿るときに混線する。

悪い例: `vein:<sys>:secrets-and-validation`(= 秘匿マスク + 入力検証 + 永続化 を 1 つに)。
動機が3つ混在し、Risk や Decision の参照経路が分かりにくくなる。

良い例: 分割する。

- `vein:<sys>:secrets-handling`(動機: 秘匿情報の漏洩防止)
- `vein:<sys>:input-validation`(動機: 入力経路からの不正値抑止)

### Pocket との二重表現禁止

ある責務領域を **Vein として立てたなら、同じファイル群を持つ Pocket を作らない**。
逆も同様。同じ概念を 2 種類のノード型で表すと、片方を更新したとき他方が陳腐化する。

判定手順: 新規 Vein のメンバー File 集合 ∩ 任意の Pocket のメンバー File 集合 が
ほぼ一致するなら、二重表現の疑い。どちらか一方に寄せる:

- 横断するなら Vein を残し Pocket を廃止。
- 局所責務なら Pocket を残し Vein を取り下げる。

## Stratum carving

### 命名(依存ピラミッドの縦位置を「意味」で名付ける)

indexer は Stratum 候補に `title="Stratum band N/M (X files)"` / `id=stratum:<sys>:bandN` という
**機械プレースホルダ**を付ける(依存深さ帯のインデックスとメンバー数)。これは構成要素であって
意味ではない。carve では **その深さ帯が担うアーキ上の役割**を読み取り、意味で名付ける:

- band は「最も依存される土台 (0)」→「入口・最上位 (大)」の順。各帯が実際に何の集まりかを
  メンバー File の役割(`role`/summary)から読み、層の**役割**を title/slug にする。
- 良い: `基盤層 — 設定・データ・共有型の土台` (`foundation`) / `ドメインロジック層 — 認証・通知・集計`
  (`domain-logic`) / `外部接点・画面層` (`interface`) / `入口・合成層 — 起動とルーティング合成`
  (`composition`)。
- **禁止**: `Stratum band 0/3 (41 files)` をそのまま確定 / slug `band0` のまま / title に
  ファイル数や band 番号を残す。これは「カスみたいな命名」= サボり(§0 / 「意味ある命名 必須」節)。
- サーバ系と web 系が同じ深さ帯に同居するのは正常(Stratum は depth 軸。モジュール境界は Pocket
  の役割)。title はその帯を貫く**共通の縦位置の意味**を表す(「土台として積まれる」「起動・合成する」等)。
- 詳細な命名規則(slug・プレースホルダ禁止・ゲート強制)は「意味ある命名 必須」節を参照。

### 対象範囲(実行依存があるものだけ)

Stratum は **依存ピラミッドの縦位置**を表す。対象に含む(= Stratum メンバーにしてよい)のは:

- 実装ソース(`src/`, `core/`, `server/`, `ui/` 等)
- 設定ファイル(`*.env`, `config/`, build profile, 設定スクリプト)
- パッケージング・配布物(`packaging/` 配下のインストーラ・WSL イメージ・systemd 等)
- 動作に必要な doc(`README`, `USER_MANUAL`, `INSTALL` 等。コードが参照する設計図含む)

**「含めてよい」と「網羅性で必須」は別。** 設定ファイル(`package.json` / `tsconfig*.json` /
`*.env*` / lock / workspace / `.claude/settings.json` 等のルート・例・雛形)や README は、依存
バンディングで自然に最下層に入るなら Stratum メンバーにしてよいが、**網羅性ゲートでは
allowed-orphan 扱い**で所属を強制しない(正本は builtin 汎用パターン +
`.graphrag/carving.json`。「allowed-orphan の正本」節)。
これらは依存関係を持たない単独 config が多く、層への割り当てを必須化するとノイズになるため。
**必須**なのは、allowed-orphan を除く実装ファイル(`role=source/test/config`)が Pocket に、
src/packaging 配下の File が Stratum に所属すること(`check-carving` の component-coverage /
layer-coverage ゲートが対象とする範囲)。

### 除外規則(Stratum に入れない)

下記は Stratum に入れない。これらは Stratum 階層の意味を曖昧にする。

- **plans / 引継書 / 過去調査 HTML**(`plans/*.html`, `plans/*.md`, `plans/backlog*/**`):
  Investigation ノードの `raw_content` で扱う。Stratum の依存対象ではない。
- **knowhow / 後知恵 doc**(`docs/knowhow/`): 過去事例集で、コードからの参照は無い。
  OperationalKnowledge ノードの `documented_by` 出所として扱う。
- **設計議論 / 採用判断 doc**: Decision ノードの `documented_by` 出所として扱う。
  Stratum メンバーにしない。
- **生成物 / 一時ファイル**(`generated/`, `dist/`, `node_modules/`, `release/`): 索引対象外。

### テストの位置(規則統一)

テストファイル(`tests/`, `*.test.ts`)は **実装と同じ Stratum に置く**。

「テスト専用 Stratum を作る」「コンポジション層に上げる」等のバリエーションは取らない。
規則がぶれると、横断クエリ時にテストが期待 Stratum に居ないことで欠落する。

### 網羅性 (Stratum 側)

src / packaging 配下の全 File は **少なくとも 1 つの Stratum に所属**すること。属さない File は
網羅性ゲート(後述)で orphan として報告する。

## 網羅性回帰ゲート

conceptual-pass のマージ前に必ず通す品質ゲート。`validateGraph` 0 失敗は通過条件、
本ゲートはその次。

### Pocket 網羅性

`src/` + `packaging/scripts/` 配下の **実装ソースファイル**は、少なくとも 1 つの Pocket に
所属していること。例外として allowed-orphan は明示的に許容する。正本は二層
(「allowed-orphan の正本」節):

- builtin 汎用パターン(composition root / 汎用 utility / 共有定義 / lock・manifest 類)
- `.graphrag/carving.json` のエントリ(プロジェクト固有・人間所有、user 承認済みのみ)

これら以外の `src/` 配下 File が Pocket 未所属なら **carving 不良として再評価**。

### Stratum 網羅性

`src/` + `packaging/` 配下の全 File(テスト含む)は少なくとも 1 つの Stratum に所属する
こと。除外規則(plans / knowhow 等)に該当しない File が Stratum 未所属なら carving 不良。

### orphan 報告

ゲートを通った後、未所属 File を残す場合は **mutation plan の `reason` フィールドに
allowed-orphan 一覧を残す**(レビュアー / 後任 LLM が意図的な除外と判別できるように)。

### 検査クエリ例

allow-orphan を控えた上で、正本である vault から読み込んだ graph オブジェクトに対し
下記で確認できる(`graph.json` は索引器出力・往復検証用の中間表現であって正本ではない)。
LLM が直接クエリを書く必要はない、人間 / スクリプト経路:

```js
// 全 File ノードのうち Pocket に属さないものを抽出
const inComp = new Set();
for (const e of graph.edges) {
  if (e.type === 'evidenced_by' && e.from.startsWith('pocket:')) inComp.add(e.to);
}
const orphans = graph.nodes.filter(n => n.type === 'File' && !inComp.has(n.id) && n.path?.startsWith('src/'));
```

## 増分追従(changed / new File)

`node graphrag/cli.ts index` の `change_status: new|changed|unchanged` を尊重する:

| change_status | 必須アクション |
|---|---|
| `unchanged` | conceptual-pass 不要。既存のまま |
| `changed` | File summary を再生成(`interpretation-guidance.md` 準拠)。所属 Pocket / Vein / Stratum は原則変えないが、ファイル名やパスが変わったら carving 再評価 |
| `new` | **必ず carving を再評価**。下記フロー参照 |

### new File が来たときのフロー

1. ファイルの path 第 1〜2 階層を見る。
2. 既存 Pocket のいずれかに「同ディレクトリ原則」で吸収できるか確認。
3. 吸収できる: 既存 Pocket に `evidenced_by` を追加するだけ。
4. 吸収できない(=新規ディレクトリ): 新 Pocket を carving。「粒度ガード」「意味 slug」
   「異物検査」を満たすこと。

### 新規ディレクトリ追加時

`core/backup/` のような新ディレクトリが出現したら、その配下に複数 File が居る場合は
**新 Pocket の carving を必須化**(`backup-manager.ts` 1 ファイルだけなら既存 Pocket
に吸収検討)。ディレクトリ単位で Pocket を切る default 原則と整合させる。

### 大量変動時

既存 Pocket のメンバー File が **半数以上変動**したら、Pocket の `title` / `summary` /
粒度を再評価する。古い title が現在のメンバーを正しく説明しているかをチェック。

## 自動検証コマンド (carving 提出前チェックの大半を機械化)

`node graphrag/cli.ts carving-check --graph <path>` で本ファイルのルール大半を機械検証する。
ERROR は必ず解消、WARN は意図ある場合は justification 必須。下記項目を判定:

1. **意味slug**: `^c\d+$` / `^band\d+$` のような連番 ID は警告 (Pocket / Stratum 両方)
2. **Stratum から doc 除外**: `role === "documentation"` の File が Stratum に居れば警告
   (構造判定: indexer の role 分類を信じる。ホワイトリスト維持不要)
3. **Pocket 網羅性**: `role ∈ {source, test, config}` で Pocket 未所属、かつ
   allowed-orphan (builtin 汎用パターン / `.graphrag/carving.json` エントリ。
   「allowed-orphan の正本」節) に該当しないファイルは ERROR
4. **Stratum 網羅性**: 上記同様 (documentation / generated は除外)
5. **Pocket-Vein Jaccard**: 実装ファイル基準で Jaccard ≥ 0.4 なら二重表現警告
   (テストは Pocket と Vein の両方に含まれて分母を膨らませるので除外して比較)
6. **Vein の主 Pocket 占有率**: ≥ 70% なら「横断条件は形式的成立だが実質単一寄り」警告
7. **indexer シグナル**: `cross_component_in_degree` が全 File で空なら、indexer 再 index
   + signal-only mutation 必要 (情報)
8. **多重 Vein 所属**: 1 ファイルが ≥3 Vein に属する → 単一動機原則違反疑い
9. **knowledge-impl-binding-missing**: Decision / OperationalKnowledge / Risk のうち、実装
   ファイルへの `sets_policy_for` または `documented_by` の紐付けが無いものを警告。
   knowhow / plans / design-decisions doc 経由しか紐付かない knowledge は「この決定/
   知見がどのコードを動かしているか」が graph 上から辿れない。`node graphrag/cli.ts edge-suggest-policy`
   で候補を機械抽出 → LLM 確認 → `sets_policy_for` mutation の流れで補完する。
   **Constraint への拡張 (`constraint-binding-missing`)**: Constraint は `constrains` エッジ
   (宛先不問) が 1 本も無ければ WARN。既存 D/OK/R の判定は不変。`add-constraint --constrains <id,...>`
   は必須 ≥1 なので typed-add 経由なら自然に満たされる (commit-mutation で constrains 無しの
   Constraint を作った時に引っかかる)。
10. **node-duplicate-suspect**: 同型ノード間 (Decision×Decision / OK×OK / Risk×Risk /
    Vein×Vein / Pocket×Pocket) の embedding cosine similarity が threshold
    (default 0.92) 以上のペアを警告。worktree マージで「同概念別命名」(例: `auto-update`
    と `auto-updater`) が発生した時の表記揺れ重複を機械検出。`--vector-index` 指定時のみ
    実行 (省略すると INFO で skip)。LLM 確認の上、片方削除 + edge 張り替えで統合。
11. **免除会計**: allowed-orphan 免除の内訳を text / JSON 出力に常時印字する。各免除の
    根拠種別 `builtin:<name>` / `role:<role>` / `config:<path>`、config 由来件数、
    実装 File に占める免除比率。比率 > 15% で WARN (免除で網羅性ゲートが形骸化している
    兆候)。builtin と重複する config エントリも WARN。carving.json の不正エントリ
    (glob / regex 文字、`reason` / `added` 欠落) と graph に存在しない path
    (stale-exemption) は ERROR
12. **knowledge-floor**: Goal が 0 件なら WARN `knowledge-floor-goal-missing`
    (design-review の scope-creep / roadmap 観点が無効な状態。conceptual-pass の
    知識軸シーディングを実施せよ)。Constraint 0 件も同形 WARN
13. **superseded-premise**: 終端 state (superseded / abandoned / closed) でないノードが、
    終端 state のノードへ `has_premise` している組を WARN (死んだ前提の検出。後継ノード
    への張り替えか、前提が本当にまだ生きているかの確認を促す。除外はしない = 可視化のみ)
14. **knowledge-description-missing**: Decision / RejectedOption / Constraint / Goal / Risk /
    OperationalKnowledge のうち `description` が欠落しているノードを WARN で列挙
    (embedding の意味担体が薄い、と message に理由を付す)。summary だけだと埋め込みが痩せて
    retrieval で引かれにくくなるため、原則どのノードにも意味の description を書く
    (`conceptual-pass.md` §0 大原則 / SKILL.md Mutation Plan の summary vs description 書き分け)。
    typed-add からは `--description "..."` で指定する。

### 閾値の根拠

- Jaccard 0.4: 実装 2 ファイル中 2 が一致 + Pocket 側にテスト 2 (実装外) で `2/(2+2)=0.5`
  あたりが「ほぼ同じ」の境界。テスト除外後の閾値はもう 1 段下げて 0.4 (= ファイル 3 中 1
  だけ別の状態) を「二重表現疑い」境界とする
- 主 Pocket 占有率 70%: 「8 ファイル中 6 が単一 Pocket」が 0.75 で警告対象。
  これより緩いと「機能セット型 Vein」(本来 1 Stratum に集中するもの) を不当に弾く

### allowed-orphan の正本 (builtin 汎用パターン + .graphrag/carving.json)

Pocket 未所属でも警告しない免除 (= 「1 file 責務の判定フロー」 step 3 に該当する
共通インフラ) の正本は二層。 ただしどちらの層でも、 step 1 (= 既存 Pocket への吸収) が
narrative 的に成立するなら、 allowed-orphan に残さず吸収を選んで良い。

**第1層: builtin 汎用パターン (コード内蔵)** — 「どのプロジェクトでも構造的に Pocket に
属さないもの」 だけを残す (基準はコードコメントに明文化):

- composition root (`services.ts` / `App.tsx` / `main.tsx` / `server/index.ts` 等の束ね役)
- 汎用 utility (`logger.ts` / `utils.ts`)
- 共有定義 (`shared/types.ts` / `shared/constants.ts`)
- lock・manifest 類

特定プロジェクト出自のパターン (旧ハードコードに居た windows-shell / winsw /
`*.utf8.bat` / `ui/index.css` 等) は builtin から削除済み。 そうした免除が必要なら
第2層の carving.json に書く。 role による免除は明確に非実装の閉集合 (documentation /
generated) のみ。 config / entrypoint 系 role は builtin 汎用パターンとの AND でのみ免除する
(role 単独では免除しない)。

**第2層: `.graphrag/carving.json` (プロジェクト固有・人間所有)**:

```json
{ "allowed_orphans": [ { "path": "<literal path>", "reason": "<必須>", "added": "YYYY-MM-DD" } ] }
```

- literal path のみ。 glob / regex 文字 (`*` `?` `[`) を含むエントリは ERROR。
- graph に存在しない path のエントリは ERROR (stale-exemption。 掃除を強制)。
- `reason` / `added` 欠落も ERROR。
- `carving-check` は `--config <path>` または graph パスからの規約解決
  (`.graphrag/carving.json`) で読む。

**carving.json は Stratum / Vein / Pocket と同格の「人間所有の概念層」**。 LLM は提案のみ可、
追記は user 承認後。 **carving.json への追記は 1-file 責務判定フロー step 4 (STOP / user 判断)
の代替にならない** — step 4 に達したら user 判断を取り、 user が免除を承認した時に初めて
追記する。 diff に carving.json の変更が含まれるレビューでは、 免除追加を findings に昇格して
人間裁定する (`graph-review-method.md` 参照)。

編集は `carving-allow` verb で行う (vault-lock を共用した原子書き。 git repo 内なら
git add+commit を試み、 失敗は非致命で出力に注記):

```sh
node graphrag/cli.ts carving-allow add --path <p> --reason <r>
node graphrag/cli.ts carving-allow remove --path <p>
node graphrag/cli.ts carving-allow list
# 削除された旧 builtin パターンに該当する graph 内 File を config エントリ案として出力
node graphrag/cli.ts carving-allow migrate --graph <path>
```

**test 連動則**: 上記 (builtin / config) で allowed-orphan な実装 file の test (`*.test.ts` /
`*.test.tsx`) も同じく allowed-orphan として扱う。 例: `logger.ts` が allowed-orphan なら
`tests/unit/core/logger.test.ts` も allowed-orphan。 これは「test は実装と同じ Pocket
に属する」 規則 (Stratum carving 節) の自然な拡張。

これ以外で Pocket に属さない実装ファイルが残ったら ERROR (= 「1 file 責務の判定
フロー」 step 4 で user 判断にエスカレーション)。

## carving 提出前チェックリスト

mutation plan を `node graphrag/cli.ts commit-mutation <plan.json>` で apply する前に、carving 不良で
ないことを確認する(`commit-mutation` は vault writer 経由で正本の vault に書く):

**Pocket**
- [ ] 各 Pocket の id は意味ある slug(連番でない)
- [ ] 各 Pocket のメンバー File 数は標準粒度 4〜20、 または 1-file Pocket として
  独自のドメイン narrative が書ける状態 (「1 file 責務の判定フロー」 step 2)
- [ ] 各 Pocket の `title` / `summary` が示す責務と、メンバー File の path が整合
  (path から明らかに別ドメインの異物が無い)
- [ ] 異ディレクトリの File を束ねる場合、`summary` に justification 1 文あり
- [ ] 1 file 責務の追加時、 判定フロー step 1 (既存吸収) → 2 (1-file Pocket) →
  3 (allowed-orphan) → 4 (stop / user 判断) の順で評価済み、 step 4 に達したものは
  user 判断を取った上で確定 (LLM 単独判断で新規 Pocket を作らない)

**Vein**
- [ ] 各 Vein のメンバー File が ≧2 Pocket を横断
- [ ] 各 Vein は 1 動機のみ(複数動機が束ねられていない)
- [ ] 同じファイル集合の Pocket が並列していない

**Stratum**
- [ ] plans / knowhow / 設計議論 doc が含まれていない
- [ ] テストが実装と同じ Stratum にある
- [ ] `dist/` / `node_modules/` / `generated/` が含まれていない

**網羅性**
- [ ] `src/` 配下 File は allowed-orphan を除き全て Pocket に所属
- [ ] `src/` + `packaging/` 配下 File は除外規則該当を除き全て Stratum に所属
- [ ] allowed-orphan は mutation plan の `reason` に明記
- [ ] `.graphrag/carving.json` への免除追加は user 承認済み (LLM は提案のみ。
  step 4 STOP の代替にしない)

**増分**
- [ ] `change_status: new` の File は carving 再評価済み
- [ ] 新規ディレクトリ追加時の新 Pocket carving 完了 or 既存吸収理由を `reason` に明記

チェックリスト全項目 OK で初めて apply する。1 項目でも違反があれば再 carving。
