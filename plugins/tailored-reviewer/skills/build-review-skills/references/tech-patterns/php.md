# PHP — Tech-Specific Bug Patterns

罠の祭典。PHPの「便利なはず」が裏目に出るパターン集。

## Execution Flow

- **`==` (loose comparison) の型変換地獄**: `0 == "foo"` は PHP 7 で `true`（"foo"が0に変換）。`"0e123" == "0e456"` は `true`（科学的記数法で両方0）。**パスワードハッシュ比較に `==` を使うと認証バイパス**。常に `===` を使う。
- **`switch` は `==` で比較する**: `switch("foo") { case 0: ... }` — `"foo" == 0` が `true` なので case 0 にマッチ。PHP 8 の `match` 式は `===` で比較するのでこの罠がない。
- **foreach 参照変数の残存**: `foreach ($arr as &$v) { ... }` の後、`$v` は配列最後の要素への参照として残る。次のループ `foreach ($arr as $v) { ... }` で最後の要素が上書きされ続ける。ループ後に `unset($v)` 必須。
- **三項演算子の左結合**: PHP 7以前では `$a ? 'a' : $b ? 'b' : 'c'` が `($a ? 'a' : $b) ? 'b' : 'c'` と評価される（他の言語と逆）。PHP 8 ではネストした三項はエラー。
- **`empty("0")` は `true`**: 文字列 `"0"` は PHP で falsy。`empty("0")` も `empty(0)` も `empty([])` も `empty("")` も `true`。バリデーションで「入力あり」を `!empty()` で判定すると `"0"` が無視される。
- **文字列のインクリメント**: `$s = 'z'; $s++;` → `$s === 'aa'`（Perl由来）。`$s = 'a9'; $s++;` → `'b0'`。数値文字列以外のインクリメントが意図しない値を生む。デクリメント `$s--` は文字列には効かない（何も起きない）。

## Resource Management

- **`@` エラー抑制演算子**: `@file_get_contents($path)` — エラーを握りつぶすが、パフォーマンスコストがある（エラーハンドラは実行される）。デバッグ不能になる。`try/catch` か返り値チェックを使う。
- **セッションロック**: `session_start()` はデフォルトでセッションファイルをロックする。同一ユーザーの並行リクエスト（Ajax複数発火）がシリアライズされる。`session_write_close()` で早期に解放するか `read_and_close` オプションを使う。
- **大量配列のメモリ**: PHP の配列は内部的にハッシュテーブル。100万要素の配列は C の配列の 10-20倍メモリを使う。大量データには `SplFixedArray` またはジェネレータ (`yield`) を使う。
- **PDO のデフォルトエラーモード**: `PDO::ERRMODE_SILENT` がデフォルト。SQLエラーが発生しても何も起きない。`PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION` を必ず設定。

## Concurrency

- **PHP はリクエストごとにプロセス/スレッドが独立**: 共有状態は存在しない（良い面）が、レースコンディションはDB/ファイル/キャッシュ層で起きる。`flock()` やDBの `SELECT ... FOR UPDATE` で排他制御。
- **ファイルベースセッションの競合**: 同一ユーザーの並行リクエストがセッションファイルをロック。後続リクエストはロック解除まで待つ。Redis/Memcachedセッションハンドラに移行するか、セッション書き込みを最小化。
- **`file_put_contents` の非原子性**: 書き込み中にクラッシュすると中途半端なファイルが残る。`LOCK_EX` フラグを付けても原子性は保証されない。一時ファイルに書いて `rename()` が安全。

## Security

- **型ジャグリング攻撃（Type Juggling）**: `"0e123456" == "0e789012"` → `true`（科学的記数法で両方0）。パスワードハッシュがたまたま `0e` で始まると認証バイパス。`hash_equals()` で定数時間比較。
- **`extract()` で変数上書き**: `extract($_GET)` — ユーザー入力で任意の変数を上書き可能。`$isAdmin` を上書きして権限昇格。絶対に使わない。
- **`unserialize()` でオブジェクトインジェクション**: `unserialize($userInput)` — `__wakeup()`, `__destruct()` 等のマジックメソッドが実行される。任意コード実行。`json_decode()` を使うか、`allowed_classes` オプションで制限。
- **`mail()` ヘッダインジェクション**: `mail($to, $subject, $body, "From: " . $userInput)` — 改行文字を含む入力でBCC追加、スパム送信が可能。PHPMailer 等のライブラリを使う。
- **SQL文字列補間**: `"WHERE id = '$id'"` — `$id` に `' OR 1=1 --` でSQLインジェクション。PDO のプリペアドステートメントを使う。`mysqli_real_escape_string` は `SET NAMES` の設定次第で不十分。
- **`include($userInput)`**: ユーザー入力をそのまま `include` / `require` に渡すとリモートファイルインクルージョン（`allow_url_include` 有効時）またはローカルファイルインクルージョン。ホワイトリストで制限。
- **`==` によるJSON認証バイパス**: `json_decode('{"password": 0}')` → `$input->password == $storedHash` が `true` になる場合がある（0とstringの比較）。JSON APIでも `===` 必須。

## Platform Constraints

- **PHP バージョン間の破壊的変更**: PHP 7→8 で `==` の挙動が変わった（`0 == ""` が `false` に）。`match` 式追加、名前付き引数追加、Union型追加。アップグレード後に比較ロジックが壊れる。
- **`mbstring` 拡張の有無**: `strlen("日本語")` は `mbstring` なしで9（バイト数）。`mb_strlen("日本語")` で3（文字数）。`mbstring` がインストールされていない環境でマルチバイト処理が壊れる。
- **`max_execution_time` のデフォルト30秒**: 長時間処理（大量データインポート、外部API連携）が途中で打ち切られる。CLI モードでは無制限だが、Web モードでは `set_time_limit()` で明示的に延長が必要。
- **`memory_limit` のデフォルト128MB**: 大きなファイル処理やExcel生成でメモリ不足。ストリーミング処理への切り替えが必要。
- **`opcache` の落とし穴**: `opcache.revalidate_freq` が0より大きいと、ファイル変更がキャッシュ期限まで反映されない。デプロイ直後に古いコードが動く。`opcache_reset()` またはデプロイ時に `opcache.validate_timestamps=0` + リスタート。

## Implementation Quality

- **配列キーの暗黙的型変換**: `$arr["1"]` と `$arr[1]` は同一キー。`$arr[true]` は `$arr[1]`、`$arr[false]` は `$arr[0]`、`$arr[null]` は `$arr[""]`。意図しないキー衝突。
- **`isset()` vs `array_key_exists()`**: `$arr["key"] = null` の場合、`isset($arr["key"])` は `false` だが `array_key_exists("key", $arr)` は `true`。null が正当な値の場合に `isset` ではキーの存在を正しく判定できない。
- **オブジェクトは参照、配列はコピー**: `$b = $a`（配列）はコピー。`$b = $obj`（オブジェクト）は参照。同じ `=` なのに挙動が違う。配列を変更しても元に影響しないが、オブジェクトを変更すると元も変わる。
- **`array_merge` vs `+` 演算子**: `array_merge` は数値キーを振り直す。`+` は既存キーを上書きしない。結合の意味が全く異なる。
- **`strpos` の戻り値**: `strpos("abc", "a")` は `0`（位置0で見つかった）。`if (strpos($str, $needle))` — 位置0が `false` 扱いになり「見つからなかった」と誤判定。`if (strpos($str, $needle) !== false)` が正しい。PHP 8 の `str_contains()` で解消。
- **クロージャの変数キャプチャ**: `for ($i = 0; $i < 3; $i++) { $funcs[] = function() { return $i; }; }` — 全クロージャが同じ `$i`（最終値3）を参照。`use ($i)` で値キャプチャする必要があるが、デフォルトは参照キャプチャではなく「キャプチャしない」（外部変数にアクセスできない）。`use` を忘れると未定義変数。
