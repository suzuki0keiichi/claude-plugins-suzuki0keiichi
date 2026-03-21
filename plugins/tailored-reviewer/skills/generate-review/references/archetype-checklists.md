# Archetype Checklists for Review Perspective Generation

When generating review perspectives, use these checklists to ensure completeness.

## Two Types of Perspectives

### Technical Concern Perspectives (Sashiko-style)
Focus on HOW code behaves. Each perspective examines ALL code through ONE technical lens.
These are populated with tech-stack-specific patterns from `references/tech-patterns/`.

### Domain Perspectives (Project-specific)
Focus on WHAT the project cares about. Generated from knowledge-base.
Examples: community-isolation, api-cost-defense, design-compliance.

Both types coexist. Generate-review produces both, and the orchestrator's
selection UI (when 8+ perspectives) lets users choose which to run.

---

## Technical Concern Perspectives (Universal)

Generate these for ALL projects. Populate check items from the project's
detected tech stack using `references/tech-patterns/{stack}.md`.

### 1. Execution Flow
Does code execute in the intended order? Are all paths reachable?
- async/await correctness (missing await, unhandled promise)
- Middleware/interceptor ordering and short-circuit behavior
- Conditional branch coverage (unreachable code, always-true guards)
- Framework lifecycle (SSR/CSR boundary, hydration, hook ordering)
- Error propagation paths (does throw reach the right catch?)
- **Guard condition symmetry** (must enumerate, not just "check"): when multiple functions process the same data source (e.g., markStale/closeExpired, create/delete, encode/decode), (1) list every early-return/continue/skip guard in each function, (2) compare the lists, (3) if a guard exists in one function but not another, flag it — the missing function likely needs the same guard or an explicit reason for omission
- **State transition gaps**: when code acts on a condition checked earlier (check-then-act), verify that external state changes between check and act are handled (e.g., label applied → time passes → close, but what if someone commented in between?)
- **Automation completeness**: if a workflow introduces a new state/label/flag, verify ALL consumers of that entity handle the new state (not just the producer)

### 2. Resource Management
Are resources acquired and released correctly?
- Database connection pool exhaustion
- Memory leaks (event listeners, closures, global caches)
- File handle / stream lifecycle (open without close)
- External API connection reuse and cleanup
- Timeout enforcement on all external calls
- **Pagination exhaustion**: API calls that fetch lists must handle pagination or enforce limits — unbounded fetches can OOM or hit rate limits
- **Cleanup on error path**: if acquisition succeeds but a later step fails, is the resource still released? (try-finally, defer, using/with)

### 3. Concurrency
Does code behave correctly under simultaneous access?
- Race conditions (check-then-act without atomicity)
- Transaction isolation level appropriateness
- Optimistic locking / retry correctness
- Deadlock potential (lock ordering)
- Shared mutable state across requests/workers
- **Concurrent workflow interference**: multiple automated processes (cron jobs, webhooks, event handlers) modifying the same entity — does ordering matter? Can they conflict?

### 4. Security
Are attack vectors closed?
- Authentication bypass (missing auth checks on routes)
- Injection (SQL, NoSQL, command, template)
- Sensitive data exposure (logs, errors, API responses)
- CSRF / SSRF / open redirect
- Cryptographic misuse (weak hash, predictable tokens)

### 5. Platform Constraints
Does code respect the runtime environment's limits?
- Serverless: cold start, execution timeout, memory limit, no local filesystem
- Edge Runtime: no Node.js APIs, limited crypto, size limits
- Container: health check, graceful shutdown, signal handling
- Browser: bundle size, main thread blocking, CSP

### 6. Implementation Quality
Is the code maintainable and correct?
- Type safety (any casts, unchecked type assertions)
- Error handling completeness (empty catch, missing error paths)
- Coding convention adherence (from knowledge-base/implementation-principles.md)
- Dead code and unused imports
- Test coverage for changed code paths
- **Silent success on failure**: process wrappers that catch errors and exit 0 (e.g., `main().catch(console.error)`) hide CI failures — top-level error handlers must propagate non-zero exit codes
- **Scope-limited protections**: guards/thresholds applied to one category but not others where the same logic applies (e.g., upvote protection only for enhancements, not bugs)
- **Parallel function consistency**: for functions in the same file with similar iteration patterns (e.g., both loop over issues), compare their error handling and guard conditions — inconsistencies are likely bugs, not intentional differences

---

## Domain Perspective Archetypes

Each archetype has REQUIRED perspectives (must always generate) and CONDITIONAL
perspectives (generate if knowledge-base contains relevant patterns).

## Web Application

### Required Perspectives
- **Authentication & Authorization**: session management, token handling, privilege escalation, CSRF
- **Data Validation**: input sanitization, output encoding, SQL injection, XSS
- **State Management**: race conditions, stale data, cache invalidation
- **API Contract**: breaking changes, backward compatibility, versioning
- **Error Handling**: user-facing errors, error leakage, recovery paths

### Conditional Perspectives
- **Payment/Financial** (if payment integration exists): transaction integrity, idempotency, audit trail
- **Real-time** (if WebSocket/SSE exists): connection lifecycle, reconnection, message ordering
- **Multi-tenancy** (if tenant isolation exists): data isolation, cross-tenant leaks, tenant-scoped queries
- **Internationalization** (if i18n exists): encoding, locale handling, RTL support

### Long-term Detriment Checks (All Web Apps)
- Component coupling trends
- Bundle size growth trajectory
- API surface area sprawl
- Dependency freshness and security
- Test coverage gaps in critical paths

## Backend Service / Microservice

### Required Perspectives
- **Service Contract**: API compatibility, schema evolution, consumer impact
- **Resilience**: circuit breakers, retry storms, timeout cascades, backpressure
- **Data Consistency**: eventual consistency handling, saga patterns, compensating transactions
- **Resource Management**: connection pools, memory leaks, file handle exhaustion
- **Observability**: logging adequacy, metric exposure, trace propagation

### Conditional Perspectives
- **Event-Driven** (if message queues exist): ordering guarantees, dead letter handling, idempotency
- **Database Migration** (if schema changes): backward compatibility, rollback safety, data migration
- **gRPC/Protocol Buffers** (if used): proto compatibility, streaming lifecycle

### Long-term Detriment Checks
- Service boundary erosion (growing shared state)
- Distributed monolith patterns
- Operational runbook gaps
- Deployment coupling between services

## Data Pipeline

### Required Perspectives
- **Data Quality**: schema validation, null handling, type coercion, duplicate detection
- **Idempotency**: reprocessing safety, exactly-once semantics
- **Resource Bounds**: memory usage per batch, partition skew, backpressure
- **Failure Recovery**: checkpoint integrity, partial failure handling, dead letter queues
- **Schema Evolution**: backward/forward compatibility, migration paths

### Conditional Perspectives
- **ML Pipeline** (if ML models involved): training/serving skew, feature drift, model versioning
- **Streaming** (if real-time processing): watermark handling, late arrival, windowing correctness

### Long-term Detriment Checks
- Data freshness degradation
- Pipeline coupling and cascading delays
- Schema debt accumulation
- Monitoring blind spots

## Mobile Application

### Required Perspectives
- **Offline Behavior**: sync conflicts, queue management, optimistic updates
- **Resource Constraints**: memory pressure, battery impact, network efficiency
- **Platform Compliance**: permission handling, lifecycle management, background restrictions
- **Data Security**: local storage encryption, keychain usage, certificate pinning

### Long-term Detriment Checks
- App size growth
- Startup time degradation
- Crash rate trends by OS version
- Deprecated API usage

## Embedded / Real-time System

### Required Perspectives
- **Timing Guarantees**: latency bounds, deadline misses, priority inversion
- **Resource Exhaustion**: stack overflow, heap fragmentation, DMA buffer management
- **Concurrency**: lock ordering, race conditions, interrupt safety
- **Hardware Interaction**: register access patterns, DMA barriers, peripheral lifecycle

### Long-term Detriment Checks
- Flash/ROM usage growth
- Interrupt latency degradation
- Power consumption trends

## Legacy Monolith

### Required Perspectives
- **Impact Scope**: hidden dependencies, implicit coupling, action-at-a-distance
- **Regression Risk**: under-tested paths, missing integration tests
- **Migration Safety**: strangler fig boundaries, shared database coupling
- **Dependency Management**: transitive dependency conflicts, version pinning

### Long-term Detriment Checks
- Module boundary violation trends
- God class/file growth
- Dead code accumulation
- Test coverage erosion in critical modules

## Universal (Always Include)

These perspectives apply to ALL archetypes:

- **Security Basics**: injection, authentication bypass, sensitive data exposure
- **Performance Regression**: algorithmic complexity changes, N+1 queries, unnecessary allocations
- **Error Handling Adequacy**: silent failures, swallowed exceptions, missing error paths
- **Design Principle Compliance**: check against knowledge-base/design-principles.md
- **Implementation Principle Compliance**: check against knowledge-base/implementation-principles.md

### AI-Generated Code Patterns

Code produced by AI coding assistants fails in predictable, recurring patterns.
These checks apply to ALL code regardless of whether AI authorship is confirmed,
because the patterns also catch human bugs of the same shape.

Sources: arXiv:2403.08937, arXiv:2512.05239, Augment Code failure patterns,
IEEE Spectrum "Newer AI Coding Assistants Are Failing in Insidious Ways" (2025),
Stack Overflow "Are bugs and incidents inevitable with AI coding agents?" (2026)

#### Structural Similarity Traps
AI generates structurally similar functions by pattern-matching, making
subtle-but-critical differences between them easy to miss.

- **Guard inheritance**: when new code is structurally modeled after existing code (or both are generated together), verify that ALL defensive checks from the original are present in the copy — or that their absence is explicitly justified. (1) List guards in the original. (2) Check each exists in the new code. (3) Flag missing ones.
- **Asymmetric error handling**: paired operations (create/delete, open/close, serialize/deserialize, encode/decode) where one side handles errors but the other doesn't. AI tends to implement the "forward" path carefully and the "reverse" path superficially.
- **Copy-divergence blindness**: when multiple functions share 90%+ structure, the 10% difference is where bugs hide. Explicitly examine ONLY the differing lines — they are disproportionately likely to be wrong.

#### Happy Path Bias
AI strongly favors generating code that works under ideal conditions.
Error handling gaps are ~2x more common in AI-generated code (Augment Code, 2026).

- **Missing edge case handling**: null/undefined inputs, empty collections, boundary values (0, -1, MAX_INT), concurrent access, network failures. For each function, ask: "what happens when the input is empty/null/enormous?"
- **Optimistic external calls**: API calls without timeout, retry, or error status checking. AI assumes external services always respond successfully.
- **Incomplete validation at boundaries**: input from users, APIs, or config files accepted without type/range/format checks. AI validates the happy path type but misses adversarial or malformed inputs.

#### Hallucinated Dependencies
AI confidently uses APIs, functions, or packages that don't exist.

- **Non-existent imports**: imported module/function/method that doesn't exist in the dependency's actual API. Verify imports resolve.
- **Wrong method signatures**: correct method name but wrong parameter order, missing required parameters, or deprecated API usage. Cross-check against actual library documentation/types.
- **Slopsquatting risk**: AI-hallucinated package names that could be registered by attackers. Verify all new dependencies exist in the package registry and are legitimate.

#### Semantic Correctness Gaps
Code that looks correct, runs without errors, but produces wrong results.

- **Plausible but wrong logic**: conditions that read naturally but are logically inverted or incomplete (e.g., `>=` vs `>`, `&&` vs `||`). These pass casual review because they "look right."
- **Type coercion traps**: implicit type conversions that silently produce wrong results (JS `==` vs `===`, string/number comparisons, falsy value handling).
- **Test-code shared blindspot**: when AI generates both code and tests in the same session, tests may validate the bug rather than catching it. Tests that only check the happy path are a signal.
