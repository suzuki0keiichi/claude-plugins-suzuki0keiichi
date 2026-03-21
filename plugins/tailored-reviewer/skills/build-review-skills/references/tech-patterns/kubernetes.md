# Kubernetes — Tech-Specific Bug Patterns

## Execution Flow

- **Readiness vs Liveness probe confusion**: Liveness failure = pod RESTART. Readiness failure = pod removed from Service endpoints (no traffic). Using liveness probe for slow startup = crash loop. Use `startupProbe` for slow-starting apps.
- **Pod termination sequence**: SIGTERM sent → `preStop` hook runs → `terminationGracePeriodSeconds` countdown → SIGKILL. If app doesn't handle SIGTERM, it gets killed after grace period. Running requests are dropped.
- **Init container failure**: If any init container fails, the pod restarts ALL init containers from the beginning. A flaky init container (e.g., DB migration) causes repeated execution of already-completed init steps.
- **CronJob concurrency policy**: Default `concurrencyPolicy: Allow` means overlapping jobs run simultaneously. If the job takes longer than the schedule interval, instances pile up. Use `Forbid` or `Replace`.
- **ConfigMap/Secret update propagation**: Pods don't automatically restart when ConfigMap changes. Mounted volumes update eventually (~1 min), but env vars from ConfigMap are set at pod start only. Rollout restart needed.

## Resource Management

- **Resource limits vs requests**: `requests` = minimum guaranteed. `limits` = maximum allowed. Setting `limits` without `requests` = `requests` defaults to `limits`. Setting `requests` too high wastes cluster resources. Setting too low = OOMKill or CPU throttling.
- **OOMKilled without warning**: Container exceeding memory `limit` is killed immediately. No graceful shutdown, no SIGTERM. Process just disappears. Set memory limit above actual peak usage.
- **Ephemeral storage**: Container filesystem writes (`/tmp`, logs) count toward ephemeral storage. Exceeding limit = pod eviction. Logs that grow unbounded cause eviction.
- **PersistentVolumeClaim access modes**: `ReadWriteOnce` = single node only. If pod moves to another node, the PV can't mount. Multi-replica deployments need `ReadWriteMany` (not all storage classes support it).
- **DNS resolution caching**: Default `ndots: 5` causes every short hostname to try 5 search domain combinations before external DNS. Causes slow DNS resolution and high CoreDNS load. Set `ndots: 2` or use FQDN.

## Concurrency

- **Rolling update surge**: `maxSurge: 25%, maxUnavailable: 25%` — during rolling update, up to 125% of desired replicas exist. If resource quotas are tight, the extra pods fail to schedule.
- **Leader election race**: Multiple replicas competing for leader lock. `lease` duration too short = frequent failovers. Too long = slow recovery on leader crash.
- **Horizontal Pod Autoscaler delay**: HPA checks metrics every 15s by default, scale-up stabilization window is 0s, scale-down is 5 minutes. Sudden traffic spike takes 15-30s to trigger scale-up. Scale-down is intentionally slow.
- **Job completion and parallelism**: `parallelism: 3, completions: 10` — runs up to 3 pods at a time until 10 complete. If a pod fails and `backoffLimit` is reached, the entire Job fails even if some completions succeeded.

## Security

- **Default ServiceAccount has API access**: Every pod gets a ServiceAccount token mounted at `/var/run/secrets/kubernetes.io/serviceaccount/token`. If RBAC is permissive, a compromised pod can query the Kubernetes API.
- **Privileged containers**: `securityContext.privileged: true` gives full host access. Container escape is trivial. Never use unless absolutely necessary (e.g., node-level daemon).
- **NetworkPolicy not enforced by default**: Defining NetworkPolicy does nothing unless the CNI plugin supports it (Calico, Cilium do; Flannel doesn't). Check your cluster's CNI.
- **Secrets are base64, not encrypted**: `kubectl get secret -o yaml` shows the value in base64 (trivially decoded). At-rest encryption needs explicit configuration (`EncryptionConfiguration`).

## Platform Constraints

- **Container image pull policy**: `imagePullPolicy: IfNotPresent` (default for tagged images) caches locally. Pushing a new image with the same tag = old image runs. Use unique tags or `Always` for mutable tags.
- **Pod disruption during node maintenance**: `kubectl drain` evicts pods. Without `PodDisruptionBudget`, all replicas can be evicted simultaneously. PDB guarantees minimum available during voluntary disruptions.
- **Ingress controller differences**: nginx-ingress, traefik, HAProxy have different annotation syntax. Configuration that works on one controller fails silently on another.

## Implementation Quality

- **Hardcoded replica count**: `replicas: 3` in the Deployment spec conflicts with HPA. HPA changes replica count, next `kubectl apply` of the manifest resets it to 3. Omit `replicas` when using HPA.
- **No resource requests/limits**: Without resource specs, pods are `BestEffort` QoS class and first to be evicted under memory pressure. Always set at least requests.
- **Missing health checks**: Without probes, Kubernetes assumes the pod is healthy immediately. Traffic arrives before the app is ready. Always define readinessProbe.
- **`latest` tag**: `image: myapp:latest` with `IfNotPresent` pull policy = never updates after first pull on each node. Use semantic version tags.
