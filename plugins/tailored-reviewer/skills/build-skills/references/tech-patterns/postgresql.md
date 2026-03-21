# PostgreSQL — Tech-Specific Bug Patterns

## Execution Flow

- **Transaction auto-commit**: Without explicit `BEGIN`, each statement is its own transaction. Multi-step operations that should be atomic aren't.
- **RETURNING clause**: `INSERT ... RETURNING *` returns inserted rows. Forgetting this and doing a separate SELECT = extra round trip and race condition window.
- **ON CONFLICT behavior**: `ON CONFLICT DO UPDATE` triggers even when no actual conflict exists if the unique constraint check races. Use `ON CONFLICT DO NOTHING` + check `rowCount` when side effects matter.
- **Trigger execution order**: BEFORE triggers modify the row before write, AFTER triggers see the final row. Multiple triggers on the same event: execution order is alphabetical by trigger name.

## Resource Management

- **Connection pool sizing**: `max_connections` (default 100) minus superuser reserved (3) = available. Each serverless function instance takes 1+ connections. Pool per-function + many functions = connection exhaustion. Use PgBouncer or Neon pooler.
- **Long-running transactions**: Hold row locks and prevent VACUUM from reclaiming dead tuples. Causes table bloat. Keep transactions as short as possible.
- **Prepared statement leak**: Connection poolers in transaction mode can't use prepared statements (they're per-connection). Prisma's prepared statement usage + PgBouncer transaction mode = errors.
- **VACUUM and autovacuum**: Heavy write tables need aggressive autovacuum settings. Default settings may not keep up, causing table bloat and index bloat.

## Concurrency

- **READ COMMITTED anomalies**: Default isolation level. Non-repeatable reads between statements in the same transaction. A SELECT that runs after another session's COMMIT sees different data.
- **Serialization failure (SERIALIZABLE)**: Transactions may fail with serialization error. Application MUST retry. Not handling retry = data loss or user error.
- **Row-level locking with `SELECT ... FOR UPDATE`**: Locks the selected rows until transaction commit. Forgetting to commit/rollback = indefinite lock. Other transactions wait or timeout.
- **Advisory locks**: `pg_advisory_lock(key)` is session-level, persists until session ends. Use `pg_advisory_xact_lock` for transaction-scoped. Forgetting to unlock = resource leak.
- **Deadlock detection**: PostgreSQL detects deadlocks and kills one transaction. But the application must handle the error and retry. Silent crash on deadlock error = lost operation.

## Security

- **SQL injection via string interpolation**: Even with ORMs, raw query methods (`$queryRaw` in Prisma, `query()` in pg) are vulnerable if using string concatenation instead of parameterized queries.
- **Row-level security (RLS) bypass**: Superuser and table owner bypass RLS. Application user must NOT be the table owner. Check with `SET ROLE` in queries.
- **pg_dump exposure**: Database dumps contain all data including secrets stored in tables. Dump files must be treated as sensitive.
- **Extension security**: `CREATE EXTENSION` runs as superuser. Malicious or vulnerable extensions = full database compromise. Audit extensions.

## Platform Constraints

- **Neon cold start**: Serverless Postgres (Neon) has compute spin-up time (~300ms). First query after idle period is slow. Use connection pooler with keepalive.
- **Statement timeout**: No default statement timeout in PostgreSQL. A bad query can run forever. Set `statement_timeout` per-session or per-role.
- **WAL growth**: Heavy writes without checkpoints = WAL disk exhaustion. Monitor `pg_wal` directory size.

## Implementation Quality

- **Missing indexes on foreign keys**: PostgreSQL does NOT auto-create indexes on foreign key columns (unlike MySQL). Every FK should have a corresponding index for JOIN performance.
- **JSONB vs normalized**: Storing structured data as JSONB avoids schema changes but loses type safety, indexing efficiency, and referential integrity. Use for truly semi-structured data only.
- **TEXT vs VARCHAR**: In PostgreSQL, `TEXT` and `VARCHAR` have identical performance. `VARCHAR(n)` only adds a length check. Don't use `VARCHAR(255)` as a habit from MySQL.
- **BIGINT/BIGSERIAL for IDs**: If IDs may exceed 2B, use BIGINT from the start. Migrating INT to BIGINT on a large table requires table rewrite = downtime.
- **NULL in NOT IN**: `WHERE id NOT IN (1, 2, NULL)` returns ZERO rows. NULL makes the entire NOT IN condition unknown. Use `NOT EXISTS` instead, or filter NULLs from the subquery.
- **COUNT(*) vs COUNT(column)**: `COUNT(*)` counts all rows. `COUNT(column)` excludes NULLs. Using the wrong one in presence of NULLs gives silently wrong counts.
- **LIMIT without ORDER BY**: Results are in undefined order. Pagination with LIMIT/OFFSET without deterministic ORDER BY returns duplicate/missing rows across pages.
- **UPDATE without WHERE**: No warning, no confirmation. Updates every row. Especially dangerous in scripts and migration code.
- **TRUNCATE vs DELETE**: `TRUNCATE` doesn't fire triggers, doesn't log individual rows, resets sequences. `DELETE FROM table` fires triggers, logs to WAL. Using TRUNCATE when triggers are expected = silent data inconsistency.
- **Default timezone is server timezone**: `timestamp without time zone` uses server TZ for `now()`. If server TZ changes (deploy to different region), all timestamps shift. Use `timestamp with time zone` always.
