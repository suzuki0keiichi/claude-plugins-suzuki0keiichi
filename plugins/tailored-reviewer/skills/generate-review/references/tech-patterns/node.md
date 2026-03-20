# Node.js — Tech-Specific Bug Patterns

## Execution Flow

- **Missing `await`**: Calling an async function without `await` — the operation fires but errors are silently lost. The most common Node.js bug pattern.
- **`try/catch` doesn't catch unhandled rejections from fire-and-forget**: `try { asyncFunc() } catch (e) { ... }` — the catch never fires because the promise isn't awaited.
- **Event emitter error handling**: `EventEmitter` crashes the process if an `'error'` event fires with no listener. Always add `.on('error', handler)`.
- **Callback vs Promise mixing**: Using `util.promisify` on a function that doesn't follow `(err, result)` convention produces silent bugs.
- **`process.exit()` before flush**: Calling `process.exit()` before async operations (logging, DB writes) complete = data loss. Use `process.exitCode = 1` and let the event loop drain.

## Resource Management

- **Event listener leaks**: Adding listeners in a loop or on every request without removing them. `emitter.setMaxListeners()` warning is a symptom, not a fix.
- **Stream backpressure**: Piping a fast readable to a slow writable without handling backpressure causes unbounded memory growth. Use `pipeline()` from `stream/promises`.
- **Timer leaks**: `setInterval` without corresponding `clearInterval` in cleanup. Common in health checks, polling, and retry loops.
- **Buffer accumulation**: Concatenating Buffers in a loop (`buffer = Buffer.concat([buffer, chunk])`) is O(n^2). Use an array and concat once.
- **Child process cleanup**: `child_process.spawn` without handling the child's exit/error events leaks processes. Always listen for `'close'` and `'error'`.

## Concurrency

- **Event loop blocking**: Synchronous operations (JSON.parse on large input, synchronous crypto, synchronous fs) block the event loop. All concurrent requests stall.
- **Shared mutable state across requests**: Module-level variables (`let cache = {}`) are shared across all requests in the same process. Race conditions on read-modify-write.
- **Promise.all partial failure**: `Promise.all` rejects on first failure, but remaining promises keep running (and their side effects persist). Use `Promise.allSettled` when side effects matter.
- **Worker thread data cloning**: Data passed to Worker threads is cloned (structured clone), not shared. Large objects = high clone cost. Use SharedArrayBuffer for performance-critical paths.

## Security

- **Prototype pollution**: `Object.assign(target, userInput)` or spread `{...userInput}` can set `__proto__` properties. Use `Object.create(null)` for dictionaries or validate keys.
- **Path traversal**: `path.join('/uploads', userInput)` — if userInput is `../../../etc/passwd`, path.join resolves it. Use `path.resolve` + verify the result starts with the intended directory.
- **RegExp ReDoS**: User-controlled input in RegExp constructor or complex regex patterns can cause catastrophic backtracking. Use `re2` for untrusted input.
- **Environment variable exposure**: `process.env` is accessible anywhere. Logging `req` objects that contain env references can leak secrets.
- **Dynamic code execution**: Functions that execute arbitrary strings as code must never receive user input. This includes indirect patterns like dynamic `require()` or `import()` with user-controlled paths.

## Platform Constraints

- **Serverless cold start**: Heavy `require()` at top level slows cold start. Lazy-load heavy modules inside handler functions.
- **Memory limit (Lambda/Vercel)**: Default 1024MB. Processing large files or accumulating results in memory can OOM. Stream processing preferred.
- **File system in serverless**: `/tmp` is the only writable directory. Contents may persist across invocations (warm start) — don't assume clean state.
- **Node.js version-specific APIs**: `fetch` is stable from Node 18. `crypto.subtle` from Node 15. Check runtime version before using newer APIs.

## Implementation Quality

- **Unhandled rejection = crash (Node 15+)**: Unhandled promise rejections terminate the process by default. Every async code path needs error handling.
- **`console.log` in production**: No structured format, no levels, no correlation IDs. Use a structured logger (pino, winston) with request context.
- **Error class information loss**: `JSON.stringify(new Error('msg'))` returns `{}`. Errors need explicit serialization for logging/API responses.
- **ESM/CJS interop**: `require()` of ESM modules fails. `import()` of CJS works but default export handling differs. Check package `type` field and exports map.
