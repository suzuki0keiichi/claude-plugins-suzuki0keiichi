# Rust — Tech-Specific Bug Patterns

## Execution Flow

- **`unwrap()` in production code**: `result.unwrap()` panics on `Err`. In library code or server handlers, this crashes the thread/process. Use `?` operator, `match`, or `unwrap_or_else`.
- **`async` function lifetime issues**: `async fn foo(s: &str) -> ...` desugars to a Future that borrows `s`. If `s` is dropped before the Future completes, compile error (good), but boxing with `Pin<Box<dyn Future>>` can hide the issue.
- **`Drop` order in structs**: Fields are dropped in declaration order. If field A holds a reference used by field B's Drop impl, B's Drop runs before A's Drop = use-after-free at Drop time. Rare but devastating.
- **`match` exhaustiveness with `_` wildcard**: Adding a new variant to an enum doesn't cause a compile error at `_ => ...` arms. The new variant silently falls through to the wildcard. Consider `#[non_exhaustive]` or explicit arms.
- **`impl Trait` in return position is opaque**: `fn foo() -> impl Iterator<Item=i32>` — the caller can't name the concrete type. If you need to store the return value in a struct, you need `Box<dyn Iterator>` or a named type.

## Resource Management

- **`Mutex` poisoning**: If a thread panics while holding a `Mutex`, the mutex becomes "poisoned." Subsequent `lock()` calls return `Err`. Many codebases use `.lock().unwrap()` which panic-chains across threads.
- **`Arc<Mutex<T>>` cloning does not clone T**: `arc.clone()` creates a new Arc pointer to the SAME Mutex. Useful but confusing when you expect an independent copy.
- **File handles not flushed**: `BufWriter` buffers writes. Dropping without explicit `flush()` may lose the last buffer. `drop(writer)` does flush, but errors from the final flush are silently discarded.
- **`mem::forget` prevents Drop**: `std::mem::forget(value)` skips the destructor. Resource leaks (file handles, locks) are memory-safe but still bugs.

## Concurrency

- **`Send` and `Sync` auto-trait confusion**: `Rc` is `!Send` (can't cross thread boundaries). Wrapping in `Mutex<Rc<T>>` doesn't make it `Send`. Must use `Arc` for shared ownership across threads.
- **Deadlock with nested locks**: `let a = mutex_a.lock(); let b = mutex_b.lock();` in one thread, reversed order in another = deadlock. Rust prevents data races at compile time but NOT deadlocks.
- **`tokio::spawn` requires `'static`**: Can't pass references into spawned tasks. Must move owned data. `let data = data.clone(); tokio::spawn(async move { use(data) })` — forgetting `clone()` moves the original.
- **Mixing `std::sync::Mutex` and `tokio::sync::Mutex`**: `std::sync::Mutex` blocks the OS thread. In async code, this blocks the tokio runtime thread. Use `tokio::sync::Mutex` for async-safe locking.

## Security

- **`unsafe` blocks**: `unsafe` disables borrow checker guarantees. Every `unsafe` block is a potential source of undefined behavior. Minimize scope, document invariants, and audit carefully.
- **Integer overflow**: Debug mode panics on overflow, release mode wraps silently. `u8::MAX + 1 = 0` in release. Use `checked_add`, `saturating_add`, or `wrapping_add` for explicit behavior.
- **`from_utf8_unchecked`**: Skips UTF-8 validation. Invalid bytes cause undefined behavior in all subsequent string operations. Use `from_utf8` (returns Result) unless you've proven validity.
- **FFI boundary**: `extern "C"` functions bypass all Rust safety guarantees. Passing Rust references to C code that stores them = dangling pointer. Use raw pointers and manage lifetime explicitly.

## Platform Constraints

- **Compilation time**: Large projects with many dependencies have significant compile times. Incremental compilation helps but `clean` build in CI can take 5-15 minutes. Use `sccache` or `cargo-chef` for Docker layer caching.
- **Binary size**: Default release binary includes debug info. Add `strip = true` and `opt-level = "z"` in `[profile.release]` for smaller binaries.
- **Cross-compilation**: `cargo build --target x86_64-unknown-linux-musl` for static Linux binaries from Mac. Needs target installed: `rustup target add ...`. C dependencies (OpenSSL) need cross-compile toolchain.

## Implementation Quality

- **`clone()` hiding performance issues**: `.clone()` compiles everywhere but deep-cloning large structs is expensive. Audit `.clone()` on hot paths — consider `Cow<T>`, references, or `Arc`.
- **`to_string()` vs `into()` vs `as_str()`**: Multiple ways to convert string types, each with different allocation behavior. `&str → String` allocates, `String → &str` is free. Using `to_string()` everywhere causes unnecessary allocations.
- **Lifetime elision hides complexity**: `fn foo(s: &str) -> &str` elides lifetimes. The compiler assumes output lifetime = input lifetime. If the function actually returns a static string or a different reference, the elided lifetime is wrong.
- **`#[derive(PartialEq)]` on floats**: `f64` implements `PartialEq` but NOT `Eq` (NaN != NaN). Deriving `PartialEq` on a struct with `f64` field means `NaN`-containing instances are never equal to themselves.
