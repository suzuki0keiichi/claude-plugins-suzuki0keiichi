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
- **Error propagation paths**: for each throw/reject in the diff, trace upward through the call stack — (1) identify the nearest catch/try, (2) check if it handles this specific error type or catches too broadly, (3) if no catch exists in the changed code, check if the caller handles it. Flag unhandled throws and catch blocks that swallow errors silently
- **Guard condition symmetry** (must enumerate, not just "check"): when multiple functions process the same data source (e.g., markStale/closeExpired, create/delete, encode/decode), (1) list every early-return/continue/skip guard in each function, (2) compare the lists, (3) if a guard exists in one function but not another, flag it — the missing function likely needs the same guard or an explicit reason for omission
- **State transition gaps**: when code acts on a condition checked earlier (check-then-act), verify that external state changes between check and act are handled (e.g., label applied → time passes → close, but what if someone commented in between?)
- **Automation completeness**: if a workflow introduces a new state/label/flag, verify ALL consumers of that entity handle the new state (not just the producer)
- **Implicit contract violation**: if the diff changes a function's behavior (return type, error conditions, side effects, calling order requirements), check all callers — do they depend on the old behavior? Contracts that are not expressed in types or interfaces ("this function must be called after init", "returns null only when X") are invisible to the compiler and break silently

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
- **Authentication bypass**: (1) list all new routes/endpoints/handlers added in the diff, (2) for each, check if auth middleware or permission check is applied, (3) compare against existing routes in the same file/module to verify the auth pattern is consistent. A new route without auth in a file where all others have auth is likely a bug
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
- **Scope-limited protections**: (1) find guards/thresholds that filter by category or type (e.g., `if (isEnhancement)`), (2) ask whether the protection logic applies equally to OTHER categories, (3) if the guard makes sense for all types but is scoped to one, flag it. Example: upvote protection only for enhancements when bugs with 10+ upvotes should also be protected
- **Parallel function consistency**: for functions in the same file with similar iteration patterns (e.g., both loop over issues), compare their error handling and guard conditions — inconsistencies are likely bugs, not intentional differences

### 7. Code Health
Does this change make the codebase more or less maintainable over time?
This perspective evaluates cognitive load and technical debt trajectory — not whether code works, but whether the next person can understand and safely change it.

**Cognitive Load** — can a developer unfamiliar with this PR understand what's happening?
- **New concept density**: (1) list new abstractions, states, flags, or implicit rules introduced in the diff, (2) if 3+ new concepts are concentrated in one file or function, flag — each concept requires the reader to build a mental model
- **Implicit state machines**: if code manages state transitions (labels, statuses, lifecycle stages) without an explicit state diagram or enum, the valid transitions and their triggers are invisible to the next developer. Flag undocumented state machines.
- **Non-obvious control flow**: callbacks, event-driven chains, or conditional dispatch where the reader must jump through 3+ files to trace a single operation. Flag when the "what happens when X" question requires reading more than 2 files.
- **Magic values and unnamed conditions**: hardcoded numbers, string comparisons, or compound boolean conditions without named constants or explanatory comments. Flag `if (days > 14)` without explanation of why 14.
- **Confusable identifiers in surrounding code**: read the existing code around the diff — if variables/parameters have similar names, similar types, and are easy to swap (e.g., `envar_name` vs `envar_uri`, both `const char*`), flag the naming as a structural bug attractor. This applies to EXISTING code, not just new code. The diff touching this area is the trigger to evaluate it.

**Technical Debt Trajectory** — does this PR increase future maintenance cost?
- **Debt introduction**: (1) list any `any` types, TODO comments, hardcoded values, duplicated logic, or suppressed warnings added in the diff, (2) compare with the existing count in the same file — is the ratio getting worse?
- **Abstraction mismatch**: code that solves a specific problem with a general mechanism (over-engineering) or a general problem with a specific hack (under-engineering). Either creates maintenance burden disproportionate to the value delivered.
- **Coupling creep**: (1) check if the diff introduces new dependencies between modules/files that were previously independent, (2) if function A now needs to know about function B's internals (not just its interface), flag the coupling
- **Consistency erosion**: if the same problem is solved differently in this PR vs existing code (e.g., error handling style, data access pattern, config approach), flag — inconsistency forces future developers to learn multiple patterns for the same thing
- **Debt perpetuation**: conforming to an existing bad pattern is NOT acceptable just because "the existing code does it this way." If the existing code has confusable naming, missing type safety, or poor error handling, and the new code follows the same pattern, flag BOTH the new code AND the existing pattern. Matching a bad convention expands the debt surface. Check bug-patterns.md — if this area is a known hotspot, the existing pattern is likely the root cause.

**Design Integrity** — does this change respect the project's design principles?
- **Design principle adherence**: read knowledge-base/design-principles.md. Does the new code follow the project's established patterns (layering, module boundaries, naming conventions, error handling style)? If the project uses DDD, is business logic leaking into infrastructure? If Clean Architecture, are dependency arrows pointing inward?
- **Dependency direction**: (1) list new imports/includes added in the diff, (2) check if any create a dependency from a lower-level module to a higher-level one, or from a stable module to an unstable one. Flag inversions.
- **Responsibility placement**: is the new code in the right file/module/layer? If a function is added to module A but its logic is about module B's domain, flag the misplacement.

**Observability & Operability** — can problems be detected and diagnosed in production?
- **Logging adequacy**: new error paths or significant state changes without log output. If an operation can fail silently, flag it.
- **Metric exposure**: new features or critical paths without performance/health metrics. Can operators tell if this code is working correctly without reading the source?
- **Debugging support**: when this code fails, does the error message contain enough context (IDs, state, input values) to diagnose the issue without reproducing it?

### 8. Strategic Alignment
Does this change move the project toward its goals, or away from them?
This perspective requires knowledge-base/roadmap.md and knowledge-base/design-principles.md. If roadmap information is unavailable, evaluate based on architectural direction and design principles.

**Problem Diagnosis** — is the PR solving the right problem?
- **Symptom vs root cause**: (1) read the related ticket/issue, (2) read the PR description, (3) does the implementation address the root cause or just suppress the symptom? A null check addition may fix the crash but the question is: why is null being passed in the first place?
- **Problem scope**: the fix addresses one occurrence, but does the same problem exist elsewhere? Check for similar code patterns in the codebase.
- **Alternative approaches**: is there a simpler or more fundamental solution? Would a type-level constraint eliminate the entire class of bug?

**Roadmap Consistency** — does this change align with where the project is heading?
- **Direction check**: read knowledge-base/roadmap.md. Does this PR introduce patterns, dependencies, or architectural decisions that conflict with planned future work? Example: adding a new ORM dependency when the roadmap includes migrating to a different database.
- **Premature decisions**: does this PR make assumptions about future requirements that lock in a design prematurely? Over-engineering for hypothetical scenarios is as risky as under-engineering.
- **Migration path**: if the project is migrating from A to B (e.g., DDS to Zenoh, monolith to microservices), does this PR add new code on the old (A) side instead of the new (B) side?

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

- **Misleading naming trust**: AI infers behavior from function/variable/class names without reading the actual implementation. In legacy or poorly-named codebases this causes silent misuse — e.g., `getUserPermissions()` actually returns roles, `isActive` means "not deleted", `OrderService` handles sorting not orders. When reviewing code that calls internal functions, read the callee's implementation to verify the name matches the actual return value, side effects, and error behavior. Especially critical in codebases with inconsistent naming conventions.
- **Plausible but wrong logic**: conditions that read naturally but are logically inverted or incomplete (e.g., `>=` vs `>`, `&&` vs `||`). These pass casual review because they "look right."
- **Type coercion traps**: implicit type conversions that silently produce wrong results (JS `==` vs `===`, string/number comparisons, falsy value handling).
- **Test-code shared blindspot**: when AI generates both code and tests in the same session, tests may validate the bug rather than catching it. Tests that only check the happy path are a signal.
