# Drift Reconciliation — 提示フォーマット詳細

LLM が **現タスクで該当ノードを retrieval 経由で読んだ かつ 同領域のコードを read した両方の文脈が揃った時のみ**、「グラフ記述と現ソースが食い違ってる」と気付いたら、書き直しを LLM 判断で勝手にやらない。

理由: drift 検出は LLM が full investigation していないので、追加 (Proactive Persistence) より誤判定リスクが高い。誤った update / delete は元情報を失う。

systematic な乖離 audit (探しに行く類) はこれと別物。ユーザーから明示的に頼まれた時だけ。現タスクの中で drift 全件チェックに走るな。

## 提示フォーマット (構造化)

```
Drift 検出: <node-id> (<type>: "<summary 抜粋>")
現コード観測: <事実 1-3 行>
選択肢:
  [u] update: summary を <提案> に書き換え (理由: ...)
  [d] delete: 該当機能/概念が消えたので node ごと削除
  [s] skip: グラフは正しい (別レイヤ / 意図的差異)、放置
  [i] investigate: ここで判断せず別調査タスクを切る
```

- `現コード観測` は事実のみ (推論を混ぜない)。観測したファイルパスを添える。
- 選択肢の提案は 1 つに絞らず、LLM が最有力と考えるものに理由を付けて並べる。最終判断はユーザー。

## ユーザー裁定後の反映

ユーザーが `[u]` / `[d]` を選んだ場合は `commit-mutation` (op:update / op:delete の plan) で vault に書き戻す (typed-update は提供しない、頻発したら検討)。plan 雛形は `${CLAUDE_PLUGIN_ROOT}/references/mutation-templates.md` の Update / Delete 節。

- `[s]` は何も書かない (skip の理由を会話で述べるだけでよい。グラフに skip 記録ノードを作らない)。
- `[i]` は調査タスクとして切り出す。調査が session を越えて続くなら `add-investigation` で Investigation を立てる (既定 state は "active")。
