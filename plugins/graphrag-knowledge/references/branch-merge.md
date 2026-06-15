# 並行作業の枝分かれと意味的 merge (vault branch)

vault は git 管理なので、知識グラフの並行作業は **vault の git ブランチ**で隔離する。枝の作成・削除は普通の git でよい (スキルは包まない)。スキルが担うのは **意味的な merge** ── git のファイル単位マージは知識グラフの意味衝突 (言い換えた重複・系譜の無い Decision 等) を取りこぼすため、merge はノード/エッジ単位で意味を見て行う。

## 手順

1. **枝を切る**: vault の git ブランチを作り、その上で `add-*` / `commit-mutation` で隔離して書く。
2. **merge 分析**: `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/graphrag/cli.ts branch-merge --branch <ref> [--main main] [--vector <index>]`
   - 分岐点 (git merge-base)・枝・main の3状態を読み、両側の差分と衝突を出し、意味判断が要る所を **判断パケット** (JSON) として返す。**何も書かない**。
   - `branch_changes` / `main_changes` = 各側が分岐点から変えた内容 (蒸留済みフィールドのみ。要約し直さない)。`flagged_conflicts` = 重点的に見る所 (機械的/意味的ラベル付き。**「引っかからない=安全」ではない**ので全体を見る)。
3. **解決して反映**: パケットを読み、統合後の姿を mutation plan として組み、`commit-mutation <plan.json>` で **main の vault に**適用する (lock/OCC/検証/原子公開/git commit は既存経路が担保)。同じ判断を別の言葉で書いた重複は 1 つに統合 (supersede/refine) し、二重に残さない。

## 制約と読み方

- `branch-merge` 自体は読み取り専用 (分析のみ)。
- `--vector` が無いと意味の近さによる重複検出は構造シグナルのみに限定される (出力の `similarity_detection` で明示)。
- 反映先 (step 3 の plan) は main の vault に向ける。枝側の vault に書いて main に git merge する運用はしない (意味衝突を git に委ねることになる)。
