# CLI Primitives Reference

`node graphrag/cli.ts <primitive> [flags]` で叩く primitive verb の flag 詳細。
typical な操作は **headline** (ask / carve / commit-mutation / add-* / inspect) で完結する。
本リファレンスは「neighbors を変えたい」「evidence packet だけ単独で欲しい」「索引だけ再生成したい」等の **段別細粒度制御** が要る時にだけ参照する。

> v3 (作業C) で FalkorDB 連携は撤去済み。`mutate` / `falkor-sync` / `falkor-export` / `list` / `drop` / `branch` verb は存在しない。書込は `commit-mutation` / `add-*` (vault writer)。

全 verb は cli.ts launcher 起動時に `.env` を 1 回読むので、`GRAPHRAG_*` env はどの primitive からも同じく見える。

---

## brief — 概要応答 (resume / query)

```sh
node graphrag/cli.ts brief --mode <resume|query> [--query "<text>"] [--limit N] [--neighbors N] [--call-number N]
```

- `--mode resume`: active Investigation を返す (focus 継続用、read-only)
- `--mode query`: ranked search の top-N を 280 字 summary で返す
- `--query`: query mode 必須
- `--limit`: matches 上限 (default 5)
- `--call-number`: 連打抑止検出用 (普段は `ask` 経由で auto)

クエリ拡張は `brief` (ひいては `ask` の段上げ) が担う:

- `--graph-rerank on|off` (**既定 off**): 上位候補どうしの graph 隣接数でスコアを押し上げる (reason に `graph:+N`)。votes が hub 度に比例して正解 leaf を押し下げるため既定 off — 島構造が均衡したグラフでのみ on を検討。
- `--gist "<想定答えの一行>"` (任意): 質問と gist を別々に埋め込み複数 query vector として渡す (semantic は各 vector との cosine の max)。質問文だけでは引きにくい言い換えを拾える。
- これらは通常 `ask "<質問>" [--graph-rerank on|off] [--gist "<一行>"]` から使う (`ask` が `brief` に配線する)。

出力: `{ generated_by, mode, graph: {...}, active|query: {...}, usage: [...] }`

## search — ランク済み近傍展開

```sh
node graphrag/cli.ts search --query "<text>" [--limit N] [--neighbors N] [--types T1,T2]
```

ranked match list + 近傍 (N hops 展開) edges。`ask` は通常 evidence で代替するが、neighbors を 2-3 にしたい / `--types` で絞りたい時に直叩き。近傍展開の graph_context はノードあたり最大 ~10 本 (edge 型優先度順)・全体 ~40 本で打ち切られる (`evidence` と同じ上限)。

## evidence — 出所付き answer packet

```sh
node graphrag/cli.ts evidence --request "<text>" [--limit N] [--neighbors N] [--types T1,T2]
```

direct_evidence (ranked) + graph_context (neighbors) + retrieval_policy + answer_instructions。`ask` の段上げ最終段で内部呼び出しされている。

Goal / Constraint / Concern / Layer / Component / Update / Delete の plan 雛形は `references/mutation-templates.md` (適用は `commit-mutation`)。

## index — 決定論索引 (git ls-files + role 分類 + 依存)

```sh
node graphrag/cli.ts index --root <repo> --system <name> [--vault <dir>] [--previous <path>]
```

- File ノード + import/dep edge を **意味解釈なし**で生成。`--system <name>` は id 規約 `<typeSlug>:<system>:<slug>` の**名前空間ラベル** (System ノードは作られない。v3.3 で root ノード型と contains は撤去)。
- **前回の本物 File summary を継ぐのは正本 vault からだけ。** 再索引時、index は
  `--vault` → `GRAPHRAG_VAULT_DIR` → `<root>/.graphrag/vault` の順で vault を解決し、
  unchanged な File は vault の authored summary (= `summary_provisional` でないもの) を継ぐ。
  vault の機械テンプレ (`summary_provisional: true`) は継がず作り直す。
- `--previous` (graph.json / indexed-graph.json scaffold) は **change_status / 削除検知専用**。
  scaffold の summary は常に機械テンプレなので **summary content には使わない**
  (旧版 graph はフラグも持たず「テンプレ=本物」と誤認する穴になるため、構造的に信用しない)。
  vault が無い初回などは全 File が `summary_provisional: true` で作り直される (= 安全側)。
- `carve` headline が内部で呼んでいる。単独で叩くのは re-index だけしたい時。

## vector-index — vector index 構築

```sh
node graphrag/cli.ts vector-index [--graph <path>] [--out <path>] [--prefix-policy auto|off]
```

embedding endpoint (`GRAPHRAG_EMBEDDING_ENDPOINT` 自動検出 or 明示) で File / Decision 等の text を embedding 化し JSON 出力。`commit-mutation` が vault 書込後に索引更新 (非致命) を内部で行うので、mutation 後に手で叩く必要は無い。vault 全体を初回索引したい時に直叩き。

- `--prefix-policy auto|off` (既定 auto): モデルが接頭辞ポリシーを持つ時 (例 `nomic-embed-text` の document/query 接頭辞)、document 接頭辞で埋め込み index メタに `prefix_policy` を記録する。クエリ側は **index メタを読んで** `prefix_policy` が在る index にだけ query 接頭辞を付ける (メタ無しの旧 index には付けない = 混在防止)。`off` で無効化。`ask` / 重複ゲート / 提案器も同じポリシーに従う。

## vault-build — graph.json → Obsidian vault

```sh
node graphrag/cli.ts vault-build <graph.json> <vault-dir> [--force]
```

graph.json (索引器出力など) から vault を生成。通常の知識書込は `commit-mutation` が graph.json を介さず直接 vault に原子書込するので不要。索引器出力を vault 化する時などに使う。`GRAPHRAG_GRAPH_JSON_PATH` / `GRAPHRAG_VAULT_DIR` 設定済みなら引数省略可。

**全消し→再構築なので空 vault の初回構築専用**。`<vault-dir>` を一旦削除して graph.json から作り直す。索引 (graph.json) には File / Pocket / Stratum しか入らないので、手で書き戻された知識ノード (Decision / OK / Risk / Constraint / Vein …) が既に在る vault に対して実行すると、それらは索引外なので消える。**上書きガード**: 既存 vault に「source graph に無いノード」があれば中断 (exit 1) する。空 vault の初回構築・graph が superset の再索引はそのまま通る。知識が蓄積された vault を再索引したいなら build-vault ではなく commit-mutation / merge フローを使う。どうしても全消しするなら `--force` (or `GRAPHRAG_VAULT_BUILD_FORCE=1`)。

## vault-import — vault → graph.json (round-trip)

```sh
node graphrag/cli.ts vault-import <vault-dir> [<out.json>]
```

vault から graph.json を再構築。**round-trip 等価性検証用** (vault 編集 → import → 元 graph と diff)。日常運用では使わない。

## concern-hint — Concern の機械ヒント (embedding 近接クラスタリング)

```sh
node graphrag/cli.ts concern-hint --graph <path> --vector-index <path> [--threshold 0.92] [--knn 1] [--min-cluster 3] [--min-span 2]
```

embedding 距離で異なる Component をまたぐ File 群を Union-Find クラスタ化、candidate JSON を出力。**Concern 発見の主役は LLM の概念的モデリング** (`conceptual-pass.md` §2) であり、本コマンドはそのモデリング後の盲点チェック用。`carve` 内部で呼ぶ。閾値調整したい時のみ直叩き。

## edge-suggest-policy — binding / relations 候補の一括抽出

```sh
node graphrag/cli.ts edge-suggest-policy --graph <path> --vector-index <path> [--missing-only] [--changed-files <list>]
node graphrag/cli.ts edge-suggest-policy --relations --graph <path> --vector-index <path> [--top-n 50]
```

3.8 以前に作られ書き込み時 suggestion を一度も受けていないストックのノードに、提案を一括で生やし直す入口。

binding モード (既定): 各 Decision/OK/Risk/Constraint について embedding 近接で「触っているはず」の File top N を抽出し、型ごと固定の提案エッジ型 (`edge_type`; Decision→sets_policy_for / Risk→risks_in / OK→documented_by / Constraint→constrains) を付けて返す (write-time suggestions と同形)。`--missing-only` で未紐付けノードに絞る (D/OK/R は sets_policy_for または documented_by が実装 File 宛、Constraint は constrains が 1 本でもあれば skip = carving-check の constraint-binding-missing と同定義)。post-merge hook 等で `--changed-files` 絞り込み。

`--relations` モード: 同型の知識ノードペア (Decision×Decision / OK×OK / Risk×Risk / Constraint×Constraint / Goal×Goal / RejectedOption×RejectedOption) の cosine が [0.80, 0.92) のものを similarity 降順で一括列挙する (`{ mode, pairs:[{a_id,b_id,similarity,note}], pair_count }`)。帯は write-time の relations 副産物と同じ (duplicate-check の RELATION_BAND_LOW/HIGH 共有)、refines / has_premise / supersede のどれにするかは LLM が中身を読んで判断。0.92 以上は重複疑いなので carving-check #10 (node-duplicate-suspect) の領域でここには出さない。embedding の追加計算はせず vector index の既存ベクトルのみ使う。

## carving-check — 品質ゲート自動検証

```sh
node graphrag/cli.ts carving-check --graph <path> [--vector-index <path>] [--config <path>] [--json]
```

連番 slug / Layer 混入 / Component 網羅性 / 重複検出 / 紐付け不在 / embedding 距離による表記揺れ重複 / knowledge-floor (Goal・Constraint 0 件) / superseded-premise (現役ノードが終端 state ノードへ `has_premise`) を機械判定。ERROR があれば exit 1。`carve` の最終段で自動。`commit-mutation` (vault writer) は carving-check を内蔵しないので、carving を伴う mutation 後は必要に応じ手で叩く。

`--config <path>` でプロジェクト固有の allowed-orphan 免除設定 (`.graphrag/carving.json`) を指定する (省略時は graph パスからの規約解決)。免除会計 (各免除の根拠種別 `builtin:<name>` / `role:<role>` / `config:<path>`、config 由来件数、実装 File に占める免除比率) を text / JSON 出力に常時印字し、比率 > 15% で WARN。config の不正 (glob 文字 / reason・added 欠落) と stale-exemption (graph に無い path) は ERROR。閾値調整: `--jaccard-threshold` (0.4) / `--dominance-threshold` (0.7) / `--duplicate-threshold` (0.92)。

## carving-allow — 孤児免除設定 (.graphrag/carving.json) の管理

```sh
node graphrag/cli.ts carving-allow add --path <p> --reason <r> [--config <path>]
node graphrag/cli.ts carving-allow remove --path <p> [--config <path>]
node graphrag/cli.ts carving-allow list [--config <path>]
node graphrag/cli.ts carving-allow migrate --graph <path>   # 旧 builtin 該当 File を config エントリ案として出力 (書き込みなし)
```

literal path のみ (glob/regex 文字はエラー)。`add` / `remove` は vault-lock を共用した原子書き (tmp+rename)。git repo 内なら git add+commit を試み、失敗は非致命で出力に注記。carving.json は Layer/Concern/Component と同格の人間所有の概念層 — LLM は提案のみ可、追記は user 承認後。

## harvest-history — git 履歴からの知識 candidate 決定論抽出

```sh
node graphrag/cli.ts harvest-history --root <repo> [--system <name>] [--out <path>]
```

書き込みなし・決定論抽出のみ: (1) revert コミット → `RejectedOption` candidate (`suggested_slug` / `title` / `commits: [hash, subject, date]` / `note`)、(2) コメントマーカー HACK / FIXME / WORKAROUND / XXX → `OperationalKnowledge` / `Risk` candidate (`path` / `line` / `marker` / `text`)。concern-hint と同じ思想の candidate JSON — 採否は LLM が個別判断して typed-add する。手順は `references/conceptual-pass.md` の「知識軸シーディング」。

## staleness-check — 知識ノードの陳腐化候補の機械抽出

```sh
node graphrag/cli.ts staleness-check [--root <repo>] [--vault <dir>] [--threshold-commits N]   # 既定: root=cwd, threshold=5
```

知識ノード (Decision/Constraint/Risk/OperationalKnowledge) の `documented_by` / `sets_policy_for` / `constrains` が指す File について、ノードの `generated_at` 以降にその path を触ったコミット数を git log で数え、閾値以上を candidate (`node_id` / `node_title` / `file_path` / `commits_since` / `last_commit_subject`) として列挙。読み取り専用・意味判断なし — 本当に陳腐化したかの判断は人間起動の audit に委ねる。vault は `--vault` か `GRAPHRAG_VAULT_DIR`。

## world-join — join a vault to a world

```sh
node graphrag/cli.ts world-join --world <dir>              # vault via GRAPHRAG_VAULT_DIR / auto-discovery
node graphrag/cli.ts world-join --world <dir> --vault <dir>  # explicit
```

Deterministic two-step: ① add this vault's path and `vault_slug` to world.json (no-op if already present), ② write `GRAPHRAG_WORLD_DIR=<dir>` to `.graphrag/.env` (overwrites existing value). Creates the world directory and world.json if absent. Warns when VAULT.md is missing; warns when `vault_slug` is not set (cross-vault refs will not resolve to this vault).

## xref-check — cross-vault 参照 / parent 整合の診断 (read-only)

```sh
node graphrag/cli.ts xref-check [--vault <dir>] [--world <dir>]
```

vault 内の全エッジから `vault:` プレフィックス付き `to` を走査し、world.json (slug 引き) で解決を試みて各参照を `resolved` (vault も node も在る) / `broken` (vault は在るが node 欠落) / `orphan` (slug の vault が無い) / `unresolvable` (`GRAPHRAG_WORLD_DIR` 未設定) に分類する。あわせて VAULT.md の `parent` (vault 包含) を検査し、`parent_status` (`none` / `resolved` / `orphan` / `self` / `schema-mismatch` / `cycle` / `unresolvable`) を summary に出す。読み取り専用 — どの vault も変更しない。`--vault` 省略時は解決済み `GRAPHRAG_VAULT_DIR` (自動発見含む)、`--world` 省略時は `GRAPHRAG_WORLD_DIR`。

## world-refresh — cross-vault 用 world-cache 再構築

```sh
node graphrag/cli.ts world-refresh [--world <dir>]    # dir 省略時は GRAPHRAG_WORLD_DIR
```

cross-vault retrieval の三層 (`正本: vault 隣の VAULT.md` / `住所録: world.json` / `写し: world-cache.json`) のうち、写しを作り直す。出力に各 vault の VAULT.md mtime (`profile_mtime`) とノード数 (`node_count`) を含め、mtime が 45 日より古い vault には `intro_hint` (「VAULT.md が <N>日前から未更新。蓄積に対して自己紹介が古い可能性」) を添える。

- **world.json** (`<world-dir>/world.json`): pointer list of vault dirs (`{"vaults": ["<path>", {"path": "...", "slug": "..."}]}`). `slug` is the `vault_slug` (cross-vault ref namespace); the xref resolver looks up vaults by slug directly from world.json. Extra keys beyond `path` and `slug` are rejected (anti-rotting-phonebook) — name/description belong in each vault's `VAULT.md`.
- **VAULT.md** (vault dir の**隣**、`.graphrag`/vector.json と同じ配置): frontmatter `name:` / `schema:` (system/project; 省略時 system) / `vault_slug:` / `parent:` + 本文に「何の知識があるか」数行。vault フォルダの中には置かない (ノード扱いされ、mutation で孤児削除される)。
- **world-cache.json** (world.json の隣): 各 vault の自己紹介の写し + embedding + 内容ハッシュ + 取得時刻。機械生成・手編集禁止。原子書き (tmp+rename)。

`ask` は `GRAPHRAG_WORLD_DIR` (または `ask --world <dir>`) が設定されている時だけ、結果に `world_hints` (「vault X にも知識がありそう」のヒント) を添える。ヒントの確度は絶対値 (confidence) に加え相対判定 (`standout`: clear/crowd/single) を持ち、候補内で突出した top1 は high に格上げされる。ヒットの主源泉は VAULT.md 本文の lexical 一致 — 自己紹介の本文を具体語彙で濃く書くのが最も効く。cache が無ければ ask 中に自動構築、ローカル vault の VAULT.md 変更はハッシュで検知してその vault だけ再 embedding するので、world-refresh を日常的に手で叩く必要はない (vault を world.json に足した直後などにまとめて作り直したい時用)。実際に別 vault へ掛けるのは呼び手が `ask "<質問>" --vault <path>` (ヒント内の `ask_command`) を実行した時だけ — 自動では掛けない。
