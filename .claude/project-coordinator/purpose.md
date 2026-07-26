# プロジェクトの目的

## オリジナルリクエスト（一語一句そのまま）

【プロジェクト】並列実行エラー対策として加えた変更のうち、不要なものを特定して戻す

【背景】
- 並列実行エラー対策として複数の変更を実施
- しかしエラーが再現しなくなった（デバッグモード有無問わず）
- 一部の変更は効果が限定的で保守コストだけが残る

【現在のステージング済み変更】
```
git status で確認すると:
- modified: plugins/project-coordinator/agents/project-coordinator.md
- renamed: .claude/project-coordinator/best-practices.md -> resources/best-practices.md
- new file: scripts/check-files.js
```

【やってほしいこと】
1. 各変更の効果範囲を分析
2. 残すべき変更と戻すべき変更を判断
3. 戻す変更については実際にロールバックを実行
4. 最終的な変更内容をまとめる

【判断材料】
- best-practices.mdの移動：リソース配置としては適切
- check-files.js：初期化時のファイル存在チェックのみに効く（実行中は無関係）
- project-coordinator.mdの警告変更：さらに元がある（036be51時点では並列実行警告なし）

現在地: plugins/project-coordinator/
git diff --cached や git show HEAD:path で元ファイル確認可能

ステージングだけでなく、過去数回分のコミット&pushも見直してほしい。すべて再現しなくなったなら、コンテキストとトークンの無駄なのでなくしたい。

## コンテキスト

並列実行エラー（"tool use concurrency issues" 400エラー）対策として加えた変更をすべて特定し、ロールバックする。エラーが再現しなくなったため、これらの変更はコンテキストとトークンの無駄になっている。

対象範囲：ステージング済み変更 + 過去数回分のコミット（push済みを含む）

## 成功基準

1. 並列実行エラー対策として加えられた変更がすべて特定されている
2. 各変更の効果範囲が分析されている
3. 残すべき変更（並列実行対策以外の価値がある）と戻すべき変更が判断されている
4. 戻す変更について実際にロールバックが実行されている（コミット取り消し、ファイル削除、変更の差し戻しなど）
5. 最終的な変更内容がまとめられている

## スコープ

### 対象コミット・変更

**調査結果：036be51時点では並列実行警告は存在しなかった**

**並列実行エラー対策として追加された変更：**

1. **5ea367f** (2026-01-12 15:03): 「モデルの賢さを信じかなり簡素化した」
   - 並列実行警告の初出: "⚠️ CRITICAL - Prevent API Errors: NEVER run multiple file operations in parallel"
   - best-practices.md追加（並列実行とは無関係の内容）
   - 記述の簡素化（並列実行とは無関係）

2. **7b8366e** (2026-01-12 16:21): 「ベストプラクティスに沿っていなかったのでやりなおした」
   - 初期化手順を「Always check existing files FIRST」に変更
   - 並列実行防止の警告を「CRITICAL - Prevent API Errors」セクションとして独立

3. **3064023** (2026-01-12 17:09): 「todowriteを使うようにした」
   - 冒頭に警告追加: "File operations must NEVER run in parallel. Use TodoWrite"
   - 初期化手順を「Use TodoWrite to handle files sequentially」に変更

**ステージング済み変更：**
- project-coordinator.mdの修正：
  - 警告を「Always use check-files.js」に変更
  - 初期化手順にcheck-files.js使用を追加
  - best-practicesパスを `resources/best-practices.md` に変更
- best-practices.mdのリネーム：`.claude/project-coordinator/` → `resources/`
- check-files.jsの追加：ファイル存在チェックスクリプト

### 判断基準

- 並列実行エラーは再現しなくなった（デバッグモード有無問わず）
- 並列実行エラー対策として追加された警告・手順・スクリプトは不要
- 並列実行対策以外の価値がある変更（best-practices.mdの内容、記述の簡素化など）は残す可能性あり
- リソース配置の改善（best-practices.mdの移動）は個別判断

### スコープ外

- 並列実行エラー対策とは無関係な変更
- 036be51以前のコミット
