# research

graphrag-knowledge の効果検証用の分析スクリプト置き場。プラグイン本体 (`plugins/`) には含まれない。

## analyze-read-phases.mjs

Claude Code の transcript (`~/.claude/projects/<project>/*.jsonl`) から、AI がプロジェクト知識 (graphrag vault) を**自発的に読みに行った瞬間**を抽出し、セッション内のどの位相 (冒頭の平静時 / 困難の渦中) で起きたかを集計する。

検証したい仮説: 「自発読みは平静時 (セッション冒頭) に偏り、エラーやリトライが続く渦中では起きない」— 強制配達 (hook/ask 注入) の価値の争点「そもそも読みに行くのか」への実測。

### 使い方

```sh
node research/analyze-read-phases.mjs <session.jsonl>... > out.json
node research/analyze-read-phases.mjs ~/.claude/projects/<project-dir>/ > out.json
```

Node.js >= 22、外部依存なし。23MB の transcript で 0.2 秒程度 (行ストリーム処理)。

### 検出するイベント

- `ask` / `cli_grep` / `cli_show` など: graphrag CLI (`cli.ts` / `$CLI`) の verb 呼び出し (heredoc 内・コマンド置換内の偽陽性は除去済み)
- `vault_grep` / `vault_read`: vault 配下 `.md` への直接 grep/cat/sed/Read (パイプ下流・書き込み・fixture vault は除外)

各イベントに: セッション内位置 (メッセージ index / 経過割合) と、直前 20 メッセージの渦中度 (is_error 件数・エラー文字列・同一ファイル再編集・コマンドリトライ。テキストマッチ抜きの `hard_score` とセッション内 percentile を併記)。

### プライバシー (public 前提の設計)

- 実行はローカルのみ。transcripts は移動も変更もしない。
- 出力は集計値のみ: 件数・index・割合・スコア・verb 名 (ホワイトリスト)・ファイル basename。**transcript 本文・コマンド文字列は一切出力しない** (内部の同一性判定は 32bit ハッシュに畳んでから保持)。

### 既知の限界

- 1 つの Bash 呼び出し内のループ (`for q in …; do $CLI ask`) は 1 イベント扱い。
- `ls vault/` のような一覧は「読み」に数えない。
- vault 判定はパス文字列ヒューリスティック (`vault` / `.graphrag`)。別名ディレクトリは `VAULT_HINT` 定数の調整が必要。
- 長期 resume + compaction を含むセッションでは `time_ratio` は無意味 (index 比率を使う)。
