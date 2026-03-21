# Redis — Tech-Specific Bug Patterns

## Execution Flow

- **`DEL` is synchronous blocking**: Deleting a key with millions of elements blocks the event loop. Use `UNLINK` for async deletion of large keys.
- **`WATCH` + `MULTI`/`EXEC` transaction aborted silently**: If a watched key changes between `WATCH` and `EXEC`, the entire transaction returns `null` (not an error). Application must check and retry. Missing this = lost updates.
- **Pub/Sub messages are fire-and-forget**: If a subscriber disconnects and reconnects, messages published during disconnection are lost. No delivery guarantee. Use Redis Streams for reliable messaging.
- **Lua script atomicity**: `EVAL` scripts are atomic but NOT interruptible. A long-running Lua script blocks ALL Redis operations. `lua-time-limit` kills it but leaves partial state if the script did writes.
- **`EXPIRE` on key update**: Some commands reset TTL, some don't. `SET` with existing key removes TTL (unless `KEEPTTL` flag). `INCR`, `LPUSH` etc. do NOT reset TTL. Knowing which commands preserve TTL is critical for cache correctness.

## Resource Management

- **Single-threaded**: All commands are sequential. One slow command (KEYS *, SORT on large set, large MGET) blocks everything. Use SCAN instead of KEYS.
- **Memory fragmentation**: Frequent alloc/dealloc of variable-size values causes memory fragmentation. `used_memory` < `used_memory_rss`. Fragmentation ratio > 1.5 = significant wasted memory.
- **`KEYS *` in production**: Scans the entire keyspace, blocks the server. Use `SCAN` with cursor. KEYS is only for debugging.
- **Connection pool sizing**: Each Redis connection uses ~1KB + buffer memory. Too many idle connections from microservices waste server memory. Size pools to actual concurrency.
- **Maxmemory eviction policy**: When memory limit hit, default `noeviction` returns errors on writes. `allkeys-lru` may evict important keys. Choose policy based on use case: cache = `allkeys-lru`, queue = `noeviction`.

## Concurrency

- **Race condition on check-then-set**: `GET key; if nil; SET key value` has a window where two clients both see nil and both set. Use `SET key value NX` (set-if-not-exists) for atomic check-and-set.
- **Distributed lock pitfalls (SETNX)**: `SET lock owner NX EX 30` — if the lock holder crashes, lock expires after 30s (good). But if the lock holder takes longer than 30s, a second client acquires the lock while the first still runs. Use Redlock or fencing tokens.
- **Pipeline response ordering**: `PIPELINE` sends multiple commands without waiting. Responses come back in order, but if you mix pipeline with non-pipeline calls on the same connection, response ordering breaks.
- **Pub/Sub connection can't do other commands**: A connection in subscription mode can only issue SUBSCRIBE/UNSUBSCRIBE. Using the same connection for regular commands after subscribing = error or silent failure.

## Security

- **Default no authentication**: Redis ships with no password. If exposed to network, anyone can read/write all data. Always set `requirepass` and use ACLs.
- **`CONFIG SET` can change runtime settings**: A connected client can change maxmemory, save configuration, or load modules. Disable dangerous commands with `rename-command CONFIG ""`.
- **Lua script injection**: `EVAL "return redis.call('GET', KEYS[1])" 1 userInput` — if key names contain special characters, they can break the Lua script. Always use parameterized KEYS and ARGV.

## Platform Constraints

- **Upstash REST API vs TCP**: Upstash Redis over HTTP has higher latency than TCP. Each command is a separate HTTP request unless pipelined. Use pipeline for multiple commands.
- **Persistence modes (RDB vs AOF)**: RDB snapshots lose data between snapshots. AOF logs every write but is slower. `appendfsync everysec` loses up to 1 second of data on crash.
- **Cluster mode key restrictions**: Multi-key commands (MGET, MSET, SUNION) only work if all keys hash to the same slot. Use `{hashtag}` in key names to force co-location.

## Implementation Quality

- **Key naming without namespace**: `user:123` from service A conflicts with `user:123` from service B sharing the same Redis. Prefix with service name: `serviceA:user:123`.
- **TTL not set on cache keys**: Cache without expiration = unbounded memory growth. Every cache SET should have an explicit TTL.
- **Large values in single key**: A 10MB JSON blob in one key blocks the server during serialization. Split into hash fields or multiple keys.
- **Hot key problem**: One frequently-accessed key concentrates all traffic on a single Redis shard. Read replicas or client-side caching for hot keys.
