# Prisma ORM — Tech-Specific Bug Patterns

## Execution Flow

- **`$transaction` sequential vs interactive**: `prisma.$transaction([query1, query2])` runs sequentially but not in a DB transaction by default (it's a batch). Use interactive transactions `prisma.$transaction(async (tx) => { ... })` for true ACID.
- **Middleware execution order**: Prisma middleware runs in registration order. A logging middleware registered after a soft-delete middleware won't see the original query.
- **`findUnique` vs `findFirst`**: `findUnique` requires a unique constraint field. Using non-unique fields silently fails or errors. `findFirst` is for non-unique lookups.
- **Implicit many-to-many relation**: Prisma creates a join table automatically. Deleting a record doesn't cascade to the join table unless `onDelete: Cascade` is set on the relation.

## Resource Management

- **Connection pool exhaustion**: Default pool size is `connection_limit` (usually 5 for serverless). Each `new PrismaClient()` creates a new pool. MUST use singleton pattern.
- **Connection string `connection_limit` parameter**: Set explicitly for serverless: `?connection_limit=1` per function, or use connection pooler (PgBouncer, Neon pooler).
- **`$disconnect()` in serverless**: Generally NOT needed for Vercel/Lambda (process reuse handles it). But for scripts and tests, always `$disconnect()` in finally blocks.
- **Large result sets without pagination**: `findMany()` without `take` loads all records into memory. For tables that grow, always include `take` and cursor-based pagination.

## Concurrency

- **Check-then-act without transaction**: `const count = await prisma.foo.count(); if (count < limit) await prisma.foo.create()` has a race condition. Use interactive transaction or database constraint.
- **Optimistic concurrency**: Prisma doesn't have built-in optimistic locking. Use `@updatedAt` field + `where` clause with expected version: `update({ where: { id, updatedAt: expected }, data: ... })`. Catch P2025 for conflict.
- **Unique constraint violation (P2002)**: Use `upsert` for insert-or-update, or catch P2002 explicitly. Unhandled P2002 becomes a 500 error.
- **Deadlocks with nested writes**: `create({ data: { related: { create: ... } } })` wraps in implicit transaction. Concurrent nested writes on related records can deadlock. Consider explicit ordering.

## Security

- **Raw queries (`$queryRaw`, `$executeRaw`)**: MUST use tagged template literals for parameterization: `prisma.$queryRaw\`SELECT * FROM users WHERE id = ${id}\``. String concatenation = SQL injection.
- **Select field exposure**: Default `findMany()` returns all scalar fields. Sensitive fields (password hash, internal flags) leak unless `select` is used.
- **BigInt serialization**: `BigInt` cannot be `JSON.stringify()`'d. API responses with BigInt IDs throw at serialization. Must convert to string explicitly.
- **Enum validation gap**: Prisma validates enum at DB level, but TypeScript allows string assignment. If API input is cast to enum type without validation, it passes TypeScript but fails at DB.

## Platform Constraints

- **Prisma Client generation required after install**: `prisma generate` must run after `npm install` in CI/Docker. Missing this = `PrismaClientInitializationError`.
- **Binary engine vs WASM**: Default is binary engine. For Edge Runtime or Cloudflare Workers, use `engineType = "wasm"` in schema. Binary engine doesn't work on Edge.
- **Docker multi-stage build**: COPY of `node_modules` in later stages overwrites generated Prisma Client. Must `prisma generate` after final COPY or preserve `.prisma/client/`.
- **Schema push vs migration**: `db push` is for prototyping (no migration files). Production should use `migrate deploy`. Mixing causes state divergence.

## Implementation Quality

- **N+1 queries**: `findMany()` then `.map(item => prisma.related.findMany({ where: { parentId: item.id } }))` is N+1. Use `include` or `select` with relations.
- **Missing indexes**: Prisma schema `@@index` is easy to forget. Fields used in `where`, `orderBy`, or `groupBy` need explicit indexes. Check slow query logs.
- **Unused `include`**: Including relations you don't use wastes queries and bandwidth. Audit `include` clauses for actually-used fields.
- **Date timezone handling**: Prisma stores `DateTime` as UTC. Comparisons with local time strings cause off-by-timezone-offset bugs.
