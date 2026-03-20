# Archetype Checklists for Review Perspective Generation

When generating review perspectives, use these checklists to ensure completeness.
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
