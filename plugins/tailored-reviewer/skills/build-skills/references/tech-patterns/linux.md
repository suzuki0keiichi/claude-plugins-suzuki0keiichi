# Linux Application Development — Tech-Specific Bug Patterns

Linux上で動作するアプリケーション/サービス/デーモン開発向けの罠。カーネル開発ではなくユーザーランド。

## Execution Flow

- **`EINTR` on system calls**: シグナル受信で `read()`, `write()`, `accept()`, `select()` 等が `EINTR` で中断される。戻り値 `-1` + `errno == EINTR` のリトライ処理がないと、正常なシグナル（`SIGCHLD`等）でI/Oが途切れる。
- **`fork()` 後の子プロセスでシグナルハンドラ未設定**: `fork()` 前にシグナルハンドラを設定しないと、親が子に `kill()` した時点で子のデフォルトハンドラ（プロセス終了）が動く。ハンドラは `fork()` 前に設定すべき。
- **`exec()` 後のFD漏洩**: `exec()` でシグナルハンドラはデフォルトに戻りメモリマッピングは解除されるが、ファイルディスクリプタは `O_CLOEXEC` なしだと残る。子プロセスが親のDB接続やソケットを意図せず持つ。
- **Shell script の `set -e` の罠**: パイプライン `cmd1 | cmd2` で `cmd1` が失敗しても `set -e` では検出されない（最後のコマンドの終了コードのみ）。`set -o pipefail` も必要。
- **`system()` のシグナル問題**: `system()` は内部で `fork` + `waitpid` する。`SIGCHLD` を `SIG_IGN` にしていると `waitpid` が失敗して `system()` が常に `-1` を返す。
- **デーモン化後のstdio消失**: `daemon()` やダブルフォーク後に `stdout`/`stderr` が `/dev/null` にリダイレクトされる。ログ出力先を明示的にファイルや syslog に設定しないと出力が消える。

## Resource Management

- **`fork()` でファイルディスクリプタが全て継承される**: 子プロセスが親のソケット、DB接続、ファイルロックを全て持つ。不要なFDを閉じないと: (1) リソースリーク (2) "address already in use" (3) ファイルロック解除不能。`O_CLOEXEC` / `SOCK_CLOEXEC` を使う。
- **ファイルディスクリプタ上限**: デフォルト `ulimit -n` は 1024。高並行サーバーでは不足。`EMFILE` (too many open files) でコネクション受付が停止する。systemd の `LimitNOFILE` またはプログラム内で `setrlimit` で引き上げ。
- **`/tmp` の容量枯渇**: `/tmp` が tmpfs（RAM上）の場合、サイズに上限がある。大量の一時ファイルや大きなファイルを `/tmp` に書くとメモリ圧迫またはディスクフル。
- **ゾンビプロセス**: `fork()` した子プロセスの終了を `wait()`/`waitpid()` で回収しないと、ゾンビ（`Z` 状態）として残り続ける。大量のゾンビはプロセステーブルを圧迫。`SIGCHLD` を `SIG_IGN` にするか、ハンドラ内で `waitpid(-1, NULL, WNOHANG)` をループ。
- **`mmap` した領域の `munmap` 忘れ**: 大きなファイルを `mmap` して `munmap` しないと仮想アドレス空間を消費し続ける。最終的に `mmap` 自体が失敗する。

## Concurrency

- **シグナルハンドラ内で安全でない関数呼び出し**: `malloc()`, `printf()`, `mutex_lock()` 等はシグナルハンドラ内で呼ぶとデッドロックや未定義動作。`write()`, `_exit()`, `sig_atomic_t` への代入のみ安全。安全な関数一覧は `signal-safety(7)` 参照。
- **`epoll` エッジトリガーでの取りこぼし**: `EPOLLET` はイベント発生時のみ通知。データを全て読み切らないと次の通知が来ない。`read()` が `EAGAIN` を返すまでループ必須。ノンブロッキングFD必須。
- **`epoll` + マルチスレッドのthundering herd**: 複数スレッドが同じ `epoll` FDを `epoll_wait` すると全スレッドが一斉に起きる。`EPOLLEXCLUSIVE` で1スレッドのみ起こす。または `EPOLLONESHOT` で手動再アーム。
- **`fcntl` F_SETFD のマルチスレッド競合**: FD作成後に `fcntl(fd, F_SETFD, FD_CLOEXEC)` する間に別スレッドが `fork()` するとFDが漏洩。`O_CLOEXEC` フラグを `open()` 時に原子的に指定すべき。
- **共有メモリの同期**: `shm_open` / `mmap` で共有した領域にmutexなしでアクセスするとCPUキャッシュ不整合。`pthread_mutexattr_setpshared` でプロセス間mutexを使う。

## Security

- **TOCTOU (Time of Check, Time of Use)**: `access(file, W_OK)` → `open(file, O_WRONLY)` の間にシンボリックリンク攻撃。`open()` してから `fstat()` で確認するか、権限をドロップして `open()` のみ使う。
- **`/tmp` の安全な使用**: 予測可能なファイル名 (`/tmp/myapp.log`) はシンボリックリンク攻撃に脆弱。`mkstemp()` で安全な一時ファイルを作成。
- **環境変数の信用**: `LD_PRELOAD`, `LD_LIBRARY_PATH`, `PATH` は攻撃者が制御可能。子プロセスの環境変数を明示的にサニタイズする。
- **core dump にシークレットが含まれる**: メモリ上のパスワードやトークンが core dump に書き出される。`prctl(PR_SET_DUMPABLE, 0)` または `madvise(MADV_DONTDUMP)` で防止。
- **コマンドインジェクション**: `system("cmd " + user_input)` や `popen` でシェル経由の実行はインジェクション脆弱。`execvp` でコマンドと引数を分離して直接実行すべき。

## Platform Constraints

- **systemd `Type=simple` vs `Type=notify`**: `Type=simple` はプロセス起動直後に「Ready」とみなす。初期化完了前に依存サービスが接続を試みる。`Type=notify` + `sd_notify("READY=1")` で初期化完了を通知。
- **systemd の高速クラッシュループ**: 起動直後に繰り返しクラッシュすると `start-limit-hit` で停止。`StartLimitIntervalSec`, `StartLimitBurst`, `RestartSec` で制御。
- **inotify のwatch上限**: デフォルト `max_user_watches` は 8192〜。ファイルwatcher系アプリはこの上限に達して監視が静かに失敗する。`/proc/sys/fs/inotify/max_user_watches` を確認・引き上げ。
- **cgroup メモリ制限とprocfs**: コンテナ内で `/proc/meminfo` はホストの値を返す。アプリがこれで「利用可能メモリ」を判断するとcgroup制限を超えてOOMKilled。`/sys/fs/cgroup/` 配下を参照すべき。
- **`/proc/self/exe` でのバイナリ再実行**: 実行中にバイナリが置換されても `/proc/self/exe` は元のinode（`(deleted)` 付き）を指す。自動更新で `execv("/proc/self/exe", ...)` すると古いバイナリが再実行される場合がある。

## Implementation Quality

- **`errno` はスレッドローカルだが即座に上書きされる**: 次のシステムコール（成功しても）で上書き。エラーチェック前に別の関数を呼ぶと `errno` が変わる。エラー検出直後に保存: `int saved_errno = errno;`。
- **`write()` の短い書き込み**: `write(fd, buf, len)` が `len` バイト未満を返すことがある（シグナル割り込み、パイプバッファ満杯）。全データ書き込みまでループが必要。
- **ファイル書き込みの永続化**: `write()` → `close()` でもデータがディスクに到達していない場合がある（カーネルバッファ内）。`fsync(fd)` で永続化。新規ファイルの場合はディレクトリの `fsync` も必要。
- **ロケールの影響**: `LC_ALL=C` でないと `sort`, `grep` の動作がロケール依存。`[a-z]` がロケールによっては `A-Z` も含む。スクリプトでは `LC_ALL=C` を明示。
- **パス名の最大長**: `PATH_MAX` (4096) は保証ではなくヒント。シンボリックリンク解決で超えることがある。`pathconf()` で実際の制限を確認。
