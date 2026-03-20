# Go — Tech-Specific Bug Patterns

## Execution Flow

- **`defer` evaluates arguments immediately**: `defer fmt.Println(x)` captures the current value of `x`, not the value at function exit. `defer func() { fmt.Println(x) }()` captures by closure (final value).
- **`range` loop variable reuse**: `for _, v := range slice { go func() { use(v) }() }` — all goroutines see the SAME `v` (the last value). Go 1.22+ fixes this for `for range`, but captured in closures before 1.22 = classic bug.
- **`nil` interface vs `nil` concrete type**: An interface holding a `nil` pointer is NOT `nil`. `var err *MyError = nil; var e error = err; e != nil` is `true`. Interface nil check checks both type and value.
- **`goroutine` leak from blocked channel**: `go func() { ch <- result }()` — if nobody reads from `ch`, the goroutine blocks forever. Leaked goroutines accumulate memory. Use buffered channels or `select` with `context.Done()`.
- **`recover` only works in deferred functions**: `recover()` in a non-deferred function returns `nil` always. Must be `defer func() { if r := recover(); r != nil { ... } }()`.
- **Multiple return values and `:=` shadowing**: `result, err := foo(); if err == nil { result, err := bar() }` — inner `:=` creates NEW `result` and `err` variables. Outer `err` is not checked.

## Resource Management

- **`http.Response.Body` must be closed AND drained**: `resp.Body.Close()` without reading to EOF prevents TCP connection reuse. `io.Copy(io.Discard, resp.Body)` before Close to drain.
- **`context` cancellation propagation**: `ctx, cancel := context.WithCancel(parent)` — forgetting `defer cancel()` leaks the context goroutine until parent cancels.
- **`os.File` not closed in loop**: `for _, name := range files { f, _ := os.Open(name); ... }` without `defer f.Close()` or explicit close in the loop body = file descriptor exhaustion.
- **`sync.WaitGroup` Add after goroutine start**: `go func() { wg.Add(1); ... ; wg.Done() }()` — `wg.Wait()` may return before `Add` is called. Always `wg.Add(1)` BEFORE `go func()`.

## Concurrency

- **Data race on map**: Maps are NOT safe for concurrent read-write. Concurrent goroutines reading and writing the same map = crash (fatal error, not panic). Use `sync.RWMutex` or `sync.Map`.
- **`select` on multiple ready channels is random**: If multiple cases in `select` are ready, Go picks one at RANDOM. Don't assume priority or ordering.
- **`sync.Mutex` is not reentrant**: Locking a mutex that's already locked by the same goroutine = deadlock. No warning, just hang.
- **Channel direction confusion**: `chan<- T` (send-only) vs `<-chan T` (receive-only). Assigning the wrong direction compiles but panics at runtime when misused.
- **Goroutine on receiver method**: `go obj.Method()` captures `obj` by reference. If `obj` is modified after the goroutine starts, the goroutine sees the new value.

## Security

- **SQL injection with `fmt.Sprintf`**: `db.Query(fmt.Sprintf("SELECT * FROM users WHERE id = '%s'", id))` — use `db.Query("SELECT * FROM users WHERE id = $1", id)` with parameterized queries.
- **`net/http` default client has no timeout**: `http.Get(url)` uses `http.DefaultClient` which has no timeout. Slow/malicious server hangs the goroutine forever. Always set `Timeout` on `http.Client`.
- **Exported fields in structs**: Any capitalized field is JSON-serializable by default. `json.Marshal(user)` includes all exported fields. Sensitive fields (password hash, tokens) need `json:"-"` tag.
- **`crypto/rand` vs `math/rand`**: `math/rand` is NOT cryptographically secure. For tokens, session IDs, passwords: use `crypto/rand`.

## Platform Constraints

- **Binary size**: Go binaries are statically linked, typically 10-20MB+. Docker images without multi-stage build are unnecessarily large. Use `FROM scratch` or `FROM alpine` with the compiled binary only.
- **`CGO_ENABLED=0` for static binary**: Default `CGO_ENABLED=1` links to libc dynamically. `FROM scratch` fails if CGO is enabled. Set `CGO_ENABLED=0` for true static binary.
- **`GOMAXPROCS` in containers**: Go reads host CPU count, not container CPU limit. In a container with 2 CPU cores but running on 64-core host, Go spawns 64 OS threads. Set `GOMAXPROCS` explicitly or use `go.uber.org/automaxprocs`.

## Implementation Quality

- **Error wrapping without `%w`**: `fmt.Errorf("failed: %v", err)` loses the original error chain. `fmt.Errorf("failed: %w", err)` preserves it for `errors.Is`/`errors.As`. Using `%v` = `errors.Is(err, target)` always false.
- **Ignoring errors with `_`**: `result, _ := riskyFunction()` — compiles, but silently swallows the error. Every `_` for an error return should have a comment explaining why it's safe to ignore.
- **Slice append gotcha**: `a := []int{1,2,3}; b := append(a[:2], 4)` — modifies `a[2]` because append reuses the underlying array when capacity allows. `b` and `a` share memory. Use `append(a[:2:2], 4)` to force copy.
- **`init()` function ordering**: `init()` runs on package import, before `main`. Multiple `init()` in one file run top-to-bottom, but across files the order depends on file name alphabetically. Don't rely on cross-file init order.
