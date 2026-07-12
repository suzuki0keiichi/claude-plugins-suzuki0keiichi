# graphrag-knowledge セットアップマニュアル

設定対象は 3 つ — **embedding サーバ** / **`.env`** / **`VAULT.md`** です。
ただし最小構成ならほとんど何も書かずに動きます。まず [最小構成](#最小構成) を見て、既定から外したい時だけ [カスタマイズ](#カスタマイズ) を読んでください。

インストール手順は [プラグイン README](../README.md) を参照してください。

---

## 最小構成

動かすのに最低限要るのは **embedding サーバ 1 つだけ**です。vault の場所・`VAULT.md`・`.env` はすべて既定のまま動きます。

1. **embedding サーバを建てます。** 手元で Ollama か LM Studio に `nomic-embed-text` を入れて起動すれば、graphrag が自動で見つけます。

   ```sh
   # Ollama の場合
   ollama serve
   ollama pull nomic-embed-text
   ```

   常時起動させておくなら NPU で建てるのがおすすめです（→ [embedding サーバ](#embedding-サーバ)）。

2. **プロジェクトのルートで初回索引します。** `carve` を実行すると `.graphrag/vault` にグラフができます。

これで完了です。`.env` も `VAULT.md` も書く必要はありません（vault は `.graphrag/vault` が自動で見つかり、schema は system が既定です）。

以降は **この既定から外したい時だけ** 読んでください。

---

## カスタマイズ

### embedding サーバ

graphrag の検索は **意味（埋め込みベクトル）検索が前提**で、文字一致だけの代替手段は持っていません。そのため埋め込みを返すサーバが 1 つ要ります。

**置き場所を `.env` に書かなければ、graphrag が手元の Ollama / LM Studio を順に探します:**

1. Ollama — `http://localhost:11434/v1`
2. LM Studio — `http://localhost:1234/v1`

どちらも、起動していて `nomic-embed-text` を提供していれば自動で採用されます。応答はするのに `nomic-embed-text` が無いサーバは、**採用せずはっきり失敗させます**（モデルが食い違ったまま検索結果が静かに狂うのを防ぐためです）。

#### NPU で建てるのがおすすめ

埋め込みサーバは一度建てたら**起動しっぱなし**で使う性質のものです。その用途には NPU が向いています:

- **普段ほとんど使われず空いています。** 開発作業（ビルド・テスト・Claude Code 本体）は CPU / GPU を使いますが NPU はめったに使わないので、埋め込みを任せても他の作業と食い合いません。
- **低消費電力・低発熱です。** 建てっぱなしにしてもバッテリーや発熱の負担が小さく、常駐させやすいです。

NPU を積むマシン（Apple Silicon の Neural Engine や、最近の AI PC の NPU など）なら、対応する実行環境で `nomic-embed-text` を NPU で動かせるよう設定しておくとよいです。NPU が無ければ GPU、それも無ければ CPU でも動きます。

プラットフォーム別の具体的な構築手順は **[embedding-npu.md](./embedding-npu.md)** にまとめています（Ubuntu / Intel NPU は実機検証済み。Windows / macOS は追記予定）。

#### 別ポート / 別マシン / OpenAI 互換サービスを使う

自動検出から外れる置き場所は `.env` に明示します。**embedding 系の設定はマシンごとに決まる**ので、リポジトリではなく `~/.graphrag/.env` に置いてください（リポジトリに書くと別マシンに持っていった時に合わなくなります）:

```sh
# ~/.graphrag/.env
GRAPHRAG_EMBEDDING_ENDPOINT=http://192.168.1.50:1234/v1
GRAPHRAG_EMBEDDING_MODEL=nomic-embed-text
# 認証が要るサーバなら:
GRAPHRAG_EMBEDDING_API_KEY=sk-...
```

`GRAPHRAG_EMBEDDING_ENDPOINT` は OpenAI 互換の `/v1/embeddings` を持つアドレスの base（末尾 `…/v1` まで）を渡します。明示した場合は自動検出を行いません。

#### モデルは `nomic-embed-text` でなくてもよい

埋め込みモデルは `nomic-embed-text` 固定ではありません。**索引生成と検索で同じモデルを使ってさえいれば**、別のモデルでも成立します。索引を作る時に使ったモデルとその出力次元が index に記録され、検索時もその記録どおりのモデルで埋め込むためです。

ただし `nomic-embed-text` をおすすめします。自動検出の対象であり、文書側とクエリ側で別々の接頭辞を付ける最適化も効くため、設定なしで素直に動きます。

別のモデルを使う場合は、`GRAPHRAG_EMBEDDING_ENDPOINT` と `GRAPHRAG_EMBEDDING_MODEL` を明示します（自動検出は `nomic-embed-text` 前提なので、別モデルは自動では選ばれません）:

```sh
# ~/.graphrag/.env
GRAPHRAG_EMBEDDING_ENDPOINT=http://localhost:1234/v1
GRAPHRAG_EMBEDDING_MODEL=mxbai-embed-large
```

**途中でモデルを変えたら索引を作り直してください。** 索引を作った時のモデルと検索時のモデルが食い違うと（次元も変わるため）検索結果が狂います。

#### 見つからない時

埋め込みサーバが見つからないと、CLI は次のような案内付きで失敗します:

```
Semantic embedding unavailable: ... .
semantic retrieval is required and lexical/ngram fallback is disabled.
Enable one of:
  - Ollama: run "ollama serve" then "ollama pull nomic-embed-text" ...
  - LM Studio: load "nomic-embed-text" and start the local server ...
  - or set GRAPHRAG_EMBEDDING_ENDPOINT to an OpenAI-compatible /v1/embeddings endpoint ...
```

確認すること:

- サーバは起動しているか
- `nomic-embed-text` を入れてあるか
- 別ポート・別マシンなら `GRAPHRAG_EMBEDDING_ENDPOINT` を `~/.graphrag/.env` に書いたか
- 認証が要るサーバで `GRAPHRAG_EMBEDDING_API_KEY` を設定したか

> 1 件の埋め込みに時間がかかる遅い環境では、`GRAPHRAG_EMBEDDING_TIMEOUT_MS`（既定 60000 ミリ秒）を上げて、待ち時間切れによる失敗を避けてください。

---

### `.env`

設定をどこに置くかで、**プロジェクトごと**の値と**マシンごと**の値を分けます:

- **vault の場所** などプロジェクトに紐づく値 → プロジェクトの `.graphrag/.env`
- **embedding サーバの場所 / モデル / 認証キー** などマシンに紐づく値 → `~/.graphrag/.env`

graphrag は CLI 起動時に env を 1 度だけ読みます。複数の場所に同じキーがあれば、**先に読まれた方が勝ちます**（上ほど優先）:

| 優先 | ソース | 主な用途 |
|---|---|---|
| 1 | shell 環境変数 | その場限りの上書き |
| 2 | `.graphrag/.env`（cwd から上方向にたどる） | プロジェクトごとの設定。worktree やサブディレクトリからでも親を見つける |
| 3 | cwd の `.env` | プロジェクト直下の素朴な `.env` |
| 4 | `.graphrag/vault` の自動発見 | `GRAPHRAG_VAULT_DIR` 未設定時に上方向の `.graphrag/vault` を採用 |
| 5 | `~/.graphrag/.env` | マシンごとに決まる値の置き場（最も下位） |

書式は素朴な `KEY=value` です。`#` 始まりはコメント、空行は無視、値はクォートしてもかまいません。

```sh
# .graphrag/.env （プロジェクトごと）
GRAPHRAG_VAULT_DIR=/Users/me/projects/myapp/.graphrag/vault
```

#### よく使うキー

| キー | 既定 | 説明 |
|---|---|---|
| `GRAPHRAG_VAULT_DIR` | `.graphrag/vault` を自動発見 | vault の場所。別の場所に置く時だけ明示します |
| `GRAPHRAG_EMBEDDING_ENDPOINT` | Ollama / LM Studio を自動検出 | embedding サーバのアドレス（`/v1` まで）。明示すると自動検出しません |
| `GRAPHRAG_EMBEDDING_MODEL` | `nomic-embed-text` | 使う埋め込みモデル名 |
| `GRAPHRAG_EMBEDDING_API_KEY` | なし | 別マシン上のサーバ用の認証キー（Bearer） |
| `GRAPHRAG_WORLD_DIR` | なし | 複数 vault をまたいで検索する時の world ディレクトリ |

#### 細かい制御（普段は触りません）

| キー | 既定 | 説明 |
|---|---|---|
| `GRAPHRAG_EMBEDDING_TIMEOUT_MS` | `60000` | 埋め込み 1 件あたりの待ち時間上限（ミリ秒） |
| `GRAPHRAG_VECTOR_PROVIDER` | `openai-compatible-embedding` | サーバ種別（`openai-compatible-embedding` / `lm-studio-embedding`） |
| `GRAPHRAG_VAULT_MODE` | — | vault 書き込みモード（`readonly` / `direct`） |
| `GRAPHRAG_SCHEMA` | `VAULT.md` の `schema` | schema プリセットの上書き |

> ほかに `GRAPHRAG_GRAPH_JSON_PATH` / `GRAPHRAG_INDEXED_GRAPH_PATH` / `GRAPHRAG_STATE_DIR` / `GRAPHRAG_VECTOR_INDEX_PATH` / `GRAPHRAG_VECTOR_INDEX_BASE` / `GRAPHRAG_VAULT_BUILD_FORCE` / `GRAPHRAG_EMBEDDING_PROBE_TIMEOUT_MS` などもありますが、いずれも個別コマンドの引数の代わりで、日常運用では設定不要です。

---

### `VAULT.md`

`VAULT.md` は vault の自己紹介ファイルです。**書かなくても動きます**（schema は system が既定です）。次のどちらかをしたい時に書きます:

- **project schema を使いたい**（時限プロジェクト用の vault）
- **複数 vault をまたいで検索したい**（cross-vault）

#### 置き場所

`VAULT.md` は **vault フォルダの「隣」**（親ディレクトリの直下）に置きます。`vault/` の**中には置きません** — 中に入れると 1 個のノードとして扱われ、書き込み時に孤児として消えてしまいます。

```
.graphrag/
├── VAULT.md        ← ここ（vault の隣）
├── cache/          ← 機械ローカルの再生成物（vector.json など）
└── vault/          ← vault 本体（ノード = .md ファイル群）
```

#### 書く内容

```markdown
---
name: myapp-core
schema: system
vault_slug: myapp
parent: myapp-platform
---

この vault は myapp のバックエンド中核（認証・課金・通知）の設計知識を持つ。
採用した認可モデル、却下したマルチテナント案、レート制限の制約、決済の運用知識などを
具体的な言葉で記述する。
```

| フィールド | いつ要るか | 説明 |
|---|---|---|
| `name` | 推奨 | vault の名前 |
| `schema` | project schema を使う時 | 省略 or `system` で system schema、`project` で project schema。vault の種別はこの schema が決めます |
| `vault_slug` | cross-vault を使う時 | vault をまたぐ参照の名前空間。world.json と一致させます |
| `parent` | cross-vault を使う時 | 親 vault の `vault_slug`（単一）。vault 同士の包含関係を表します。省略で親なし |

本文の数行は飾りではなく、**複数 vault をまたぐ検索で「どの vault に何があるか」の手がかりに使われます**。抽象的に書くと似た vault と区別がつかなくなるので、**具体的な言葉で書く**ほど精度が上がります。cross-vault を使わないなら本文は省いてかまいません。

---

### `.gitignore`

`.graphrag/` には性質の違うものが同居します。**知識・意図的な設定は追跡し、機械ローカル／再生成可能なものだけ無視**します。`.graphrag/` を丸ごと無視すると vault（＝知識の正本）まで失うので避けてください。

| パス | 性質 | git |
|---|---|---|
| `.graphrag/vault/` | 知識グラフ（単一正本） | **追跡** |
| `.graphrag/VAULT.md` | vault の自己紹介（schema/slug/parent） | **追跡** |
| `.graphrag/carving.json` | carving 免除（意図的な判断の記録） | **追跡** |
| `.graphrag/.env` | vault パス・mode・embedding endpoint。マシン／worktree ごと | 無視 |
| `.graphrag/cache/` | 機械ローカルの再生成物ぜんぶ — ベクトル索引（`vector.json` / `vector-index.json`）、carve の索引出力（`indexed-graph.json`）、`ask` の呼び出し履歴（`ask-state.json`）、書き込みロック／seqlock（`vault.lock` / `vault.seq`） | 無視 |

そのまま貼れる `.gitignore`:

```gitignore
# graphrag-knowledge — 機械ローカル / 再生成可能（コミットしない）
.graphrag/.env
.graphrag/cache/
# 追跡したまま: .graphrag/vault/ , .graphrag/VAULT.md , .graphrag/carving.json
```

`cache/` は**書き込み（typed-add / commit-mutation / carve）が走っていない時なら丸ごと削除して安全**です。ベクトル索引は次の検索時に自動再構築され、`vault.seq` のリセットも設計上許容されています。なお v1.9 以前はこれらのファイルが `.graphrag/` 直下にありました。旧配置のファイルが残っていても読み取りは自動でフォールバックし、次の書き込みから新配置（`cache/`）に移ります（旧ファイルは消して問題ありません）。

> vault を別リポジトリ（`GRAPHRAG_VAULT_DIR` で外部パス）に置く構成なら、vault はそのリポ側で管理され、プロジェクト側 `.graphrag/` には上記の「無視」ファイルしか残らないので、無視リストはそのまま使えます。外部 vault を `GRAPHRAG_VAULT_MODE=readonly` で参照する場合、ask の履歴や自動再構築されたベクトル索引は**参照側**（ローカル `.graphrag/cache/external/<hash>/`）に書かれ、外部 vault リポジトリには何も書き込まれません（pull したての vault がそのまま使えます）。

---

### アップグレード時の注意（v1.10）

**ベクトル索引を一度作り直してください**（`vector-index` を 1 回実行）。検索の確度判定（`match_confidence`）は索引構築時に打刻されるノイズ分布（`noise_baseline`）からの**コーパス相対マージン**で行います。旧バージョンで作った索引には打刻が無く、暫定の絶対値バンドに落ちます — 再構築すれば相対判定になります。

---

## 関連

- [プラグイン README](../README.md) — インストール・使い方の概要
- [graphrag-overview.html](./graphrag-overview.html) — 設計思想の俯瞰
- [graphrag-project-vault.html](./graphrag-project-vault.html) — project vault の解説
