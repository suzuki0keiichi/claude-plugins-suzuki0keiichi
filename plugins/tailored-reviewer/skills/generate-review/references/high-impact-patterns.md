# High-Impact Bug Patterns (CWE Top 25 based)

Conditional patterns applied based on project characteristics detected in Step 2.
Each pattern has a **condition** — only include in generated skills when the condition is met.

generate-review reads this file and evaluates conditions against:
- Detected tech stack (Step 2a)
- Knowledge-base entries (Step 1)
- workspace/ code analysis (Step 2)

---

## Condition Reference

| Condition ID | What to check |
|-------------|---------------|
| `concurrent` | goroutines, threads, workers, async task queues, multiple cron jobs modifying shared state |
| `database` | SQL/NoSQL operations, ORM usage, migration files |
| `manual-memory` | C, C++, Rust unsafe blocks, manual alloc/free |
| `array-heavy` | Index-based access as core logic (parsers, buffers, matrix ops) |
| `external-api` | HTTP clients, SDK calls, webhook consumers |
| `file-io` | File read/write, stream processing, temp file creation |
| `user-input` | Form handling, CLI argument parsing, API request bodies |
| `auth` | Authentication/authorization logic, session management |
| `subprocess` | Process spawning, shell execution, command construction |
| `serialization` | Deserialization of untrusted data (JSON.parse of external input, unsafe deserializers, YAML.load) |

---

## Patterns

### Concurrency & Deadlock (`concurrent`)

| Check | CWE | Concern | Description |
|-------|-----|---------|-------------|
| Deadlock from lock ordering | CWE-833 | concurrency | Two or more locks acquired in different orders across code paths |
| Infinite wait / missing timeout | CWE-835 | resource-management | Blocking call (channel receive, mutex lock, semaphore wait) without timeout or cancellation |
| Write-write race on shared state | CWE-362 | concurrency | Concurrent writes to shared variable/map/collection without synchronization |
| Goroutine/thread leak | CWE-401 | resource-management | Spawned concurrent task that can block forever (blocked channel, unclosed connection) without cleanup path |

### Database (`database`)

| Check | CWE | Concern | Description |
|-------|-----|---------|-------------|
| Unconditioned DELETE/UPDATE | CWE-89 | security | DELETE or UPDATE without WHERE clause, or with user-controlled WHERE |
| SQL injection via string concat | CWE-89 | security | Query built by concatenation/interpolation instead of parameterized query |
| Missing transaction for multi-step mutation | CWE-362 | execution-flow | Multiple related writes without transaction — partial failure leaves inconsistent state |
| N+1 query in loop | — | resource-management | Database query inside a loop iterating over a collection — should be batched |
| Schema migration without rollback | — | execution-flow | Destructive schema change (DROP COLUMN, type change) without reversible migration |

### Memory Safety (`manual-memory`)

| Check | CWE | Concern | Description |
|-------|-----|---------|-------------|
| Use after free | CWE-416 | execution-flow | Pointer/reference used after the object has been deallocated |
| Double free | CWE-415 | execution-flow | Same memory freed twice — heap corruption |
| Buffer overflow | CWE-120 | security | Write beyond allocated buffer bounds |
| Null pointer dereference | CWE-476 | execution-flow | Pointer used without null check after fallible operation |
| Uninitialized memory read | CWE-908 | execution-flow | Variable read before assignment — undefined behavior |

### Array/Index Operations (`array-heavy`)

| Check | CWE | Concern | Description |
|-------|-----|---------|-------------|
| Out-of-bounds access | CWE-129 | execution-flow | Array/list index not validated against length before access |
| Off-by-one in loop bounds | CWE-193 | execution-flow | Loop iterates one too many or too few times (< vs <=, 0-based vs 1-based) |
| Negative index | CWE-129 | execution-flow | Index derived from external input without non-negative validation |

### External API (`external-api`)

| Check | CWE | Concern | Description |
|-------|-----|---------|-------------|
| Missing timeout | CWE-400 | resource-management | HTTP/RPC call without explicit timeout — can hang indefinitely |
| Retry storm | — | resource-management | Retry without backoff or jitter — amplifies load during outages |
| Unchecked error response | CWE-252 | execution-flow | API returns error status but caller only checks for success (e.g., 403 treated as empty result) |
| Rate limit ignorance | CWE-770 | resource-management | Bulk operations against rate-limited API without throttling |
| SSRF via user-controlled URL | CWE-918 | security | URL constructed from user input without allowlist validation |

### File I/O (`file-io`)

| Check | CWE | Concern | Description |
|-------|-----|---------|-------------|
| Resource leak on error path | CWE-404 | resource-management | File/stream opened but not closed when intermediate operation throws |
| Path traversal | CWE-22 | security | File path constructed from user input without sanitization (../ escape) |
| TOCTOU (time-of-check-time-of-use) | CWE-367 | execution-flow | File existence checked, then opened — another process can modify/delete in between |
| Temp file race | CWE-377 | security | Predictable temp file names allowing symlink attacks |

### User Input (`user-input`)

| Check | CWE | Concern | Description |
|-------|-----|---------|-------------|
| Missing input validation at boundary | CWE-20 | security | External input accepted without type/range/format validation |
| Integer overflow from input | CWE-190 | execution-flow | Numeric input not checked for overflow before arithmetic |
| ReDoS (regex denial of service) | CWE-1333 | security | User input matched against regex with catastrophic backtracking potential |

### Authentication (`auth`)

| Check | CWE | Concern | Description |
|-------|-----|---------|-------------|
| Missing auth on new endpoint | CWE-862 | security | New route/handler added without authentication middleware |
| Privilege escalation via parameter | CWE-269 | security | User can modify request to access other users' data (IDOR) |
| Hardcoded credentials | CWE-798 | security | API keys, passwords, or tokens in source code |

### Subprocess (`subprocess`)

| Check | CWE | Concern | Description |
|-------|-----|---------|-------------|
| Command injection | CWE-78 | security | Shell command constructed from user input without escaping |
| Argument injection | CWE-88 | security | User input passed as CLI argument without validation (-- prefix injection) |

### Serialization (`serialization`)

| Check | CWE | Concern | Description |
|-------|-----|---------|-------------|
| Insecure deserialization | CWE-502 | security | Untrusted data deserialized with type-coercing deserializer (unsafe YAML/XML loaders, Java ObjectInputStream, etc.) |
| Prototype pollution | CWE-1321 | security | JSON.parse or object merge of untrusted input without prototype chain protection (JS/TS) |
