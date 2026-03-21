# MySQL/MariaDB — Tech-Specific Bug Patterns

## Execution Flow

- **Implicit commit by DDL**: `ALTER TABLE`, `CREATE INDEX`, `TRUNCATE` implicitly commit any open transaction BEFORE executing. A `BEGIN; UPDATE ...; ALTER TABLE ...;` commits the UPDATE even if you wanted to rollback.
- **`INSERT ... ON DUPLICATE KEY UPDATE` increments auto_increment**: Even when the row already exists and only UPDATE runs, the auto_increment counter increments. Gaps in IDs grow faster than expected.
- **`GROUP BY` with non-aggregated columns (MySQL < 5.7 or `ONLY_FULL_GROUP_BY` off)**: MySQL returns an arbitrary value for non-aggregated columns. No error, just silently wrong data. MariaDB defaults differ from MySQL.
- **`REPLACE INTO` = DELETE + INSERT**: Not an UPDATE. Triggers ON DELETE, resets auto_increment, changes the row's primary key if it's auto-generated. Use `INSERT ... ON DUPLICATE KEY UPDATE` instead.

## Resource Management

- **Connection limit exhaustion**: Default `max_connections = 151`. Each serverless function instance holds a connection. Pool per-function × many functions = "Too many connections". Use connection pooler (ProxySQL, PlanetScale).
- **`wait_timeout` kills idle connections**: Default 8 hours. Connection pool holds idle connections that server kills after timeout. Next query on dead connection fails. Pool must validate connections before use.
- **Large transactions hold locks**: InnoDB row locks are held until transaction commits. Long transaction + many row updates = table-wide slowdown for concurrent queries.
- **Temp table disk spillover**: Complex queries with `ORDER BY`, `GROUP BY`, `DISTINCT` create temp tables. If they exceed `tmp_table_size`, they spill to disk, performance drops dramatically.

## Concurrency

- **Default isolation is REPEATABLE READ**: Unlike PostgreSQL (READ COMMITTED). A long-running transaction in MySQL sees a snapshot from transaction start. Reads don't see committed changes from other transactions. Can cause application logic to act on stale data.
- **Gap locks in REPEATABLE READ**: InnoDB locks gaps between index records to prevent phantom reads. `SELECT ... WHERE id > 10 FOR UPDATE` locks a RANGE, blocking inserts in that range from other transactions. Unexpected deadlocks.
- **`LOCK TABLES` and transactions**: `LOCK TABLES` implicitly commits open transaction. Mixing with `START TRANSACTION` causes confusion — the lock is released on next `START TRANSACTION`.
- **Auto-increment and rollback**: Auto-increment values are NOT rolled back on transaction rollback. This is by design but causes ID gaps that surprise application code expecting sequential IDs.

## Security

- **`NO_BACKSLASH_ESCAPES` SQL mode**: When enabled, backslash is not an escape character. `mysql_real_escape_string` behaves differently. Switching modes between environments = injection vulnerability.
- **`LOAD DATA LOCAL INFILE`**: Allows client to read arbitrary local files and send to server. If enabled, a malicious server can request any file from the client. Disable `local_infile` unless needed.
- **User-defined variables `@var` are session-scoped**: Accessible across queries in the same session. If connection pool reuses sessions, variables from a previous user's queries leak.

## Platform Constraints

- **PlanetScale doesn't support foreign keys**: By design (for online DDL). Referential integrity must be enforced in application code. Missing this = orphaned records, no cascade.
- **`utf8` is NOT real UTF-8**: MySQL's `utf8` charset is actually `utf8mb3` (max 3 bytes). Emoji and some CJK characters (4 bytes) get truncated. Use `utf8mb4` always.
- **Online DDL limitations**: `ALTER TABLE` on large tables can lock the table for extended periods. Even with `ALGORITHM=INPLACE`, some operations (changing column type, adding fulltext index) require table rebuild.

## Implementation Quality

- **Silent truncation**: Inserting a string longer than column's VARCHAR length silently truncates in non-strict mode. `sql_mode` must include `STRICT_TRANS_TABLES` to error. Check `sql_mode` setting.
- **`0000-00-00` as date**: MySQL allows `0000-00-00` as a date value in non-strict mode. Most application code can't handle this. Parsing fails or produces unexpected results.
- **`FLOAT`/`DOUBLE` precision**: `FLOAT` has ~7 digits precision, `DOUBLE` ~15. Storing currency as FLOAT = rounding errors. Use `DECIMAL(10,2)`.
- **`ENUM` ordering**: `ENUM` values are stored as integers (1, 2, 3...). `ORDER BY enum_column` sorts by definition order, not alphabetical. Adding values in the middle changes sort order of existing data.
