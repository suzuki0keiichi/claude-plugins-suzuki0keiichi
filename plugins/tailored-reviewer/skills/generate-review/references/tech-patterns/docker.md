# Docker — Tech-Specific Bug Patterns

## Execution Flow

- **PID 1 signal handling**: The first process (PID 1) doesn't get default signal handlers. `SIGTERM` is ignored, `docker stop` waits 10s then `SIGKILL`s. Fix: use `exec` form CMD (`CMD ["node", "app.js"]` not `CMD node app.js`), or use `tini`/`dumb-init` as init process.
- **Shell form vs exec form CMD**: `CMD node app.js` runs under `/bin/sh -c`, creating a shell parent process. `CMD ["node", "app.js"]` runs directly. Shell form: signals go to shell, not app. App never receives graceful shutdown signal.
- **ENTRYPOINT + CMD interaction**: `CMD` provides defaults that `ENTRYPOINT` receives as arguments. If both are defined, `CMD` becomes arguments to `ENTRYPOINT`. Overriding CMD at `docker run` doesn't override ENTRYPOINT. Confusing when debugging "wrong command."
- **Build stage variables don't carry over**: `ARG` in one stage doesn't exist in the next stage of multi-stage build. Must re-declare `ARG` after each `FROM`.
- **`.dockerignore` not excluding `.env`**: `.env` files copied into image = secrets baked into the layer. Even if deleted later, the layer still contains them. Add `.env*` to `.dockerignore`.

## Resource Management

- **Layer cache invalidation by COPY order**: `COPY . .` before `RUN npm install` invalidates the install cache on EVERY source change. Correct order: COPY package*.json → RUN install → COPY source.
- **Multi-stage COPY overwrites generated files**: `COPY --from=builder /app/node_modules ./node_modules` overwrites files generated in current stage (e.g., Prisma client, native bindings). Order of COPY matters.
- **Dangling images accumulate**: Each build creates layers. Without `docker image prune`, disk fills up. CI systems especially vulnerable.
- **Volume mount hides container files**: `docker run -v ./data:/app/data` replaces the container's `/app/data` with the host directory. Files that existed in the container image at that path disappear.
- **`apt-get install` without cleanup**: `apt-get install` leaves cache in the image. Must `rm -rf /var/lib/apt/lists/*` in the SAME `RUN` layer (not a separate one).

## Concurrency

- **Health check race on startup**: Health check starts immediately. If app needs 5s to boot, the first health checks fail, container may be restarted before it's ready. Use `--start-period` or `--start-interval`.
- **Docker Compose `depends_on` doesn't wait for healthy**: `depends_on: [db]` only waits for the container to START, not for the service to be READY. Use `depends_on: { db: { condition: service_healthy } }` with health check.
- **Shared network port conflicts**: Two containers in the same network can't bind the same port. But host port mapping (`-p 3000:3000`) is different from container port. Mapping the same host port twice fails silently — second container just doesn't get traffic.

## Security

- **Running as root by default**: Container processes run as root unless `USER` is specified. Container escape + root = host root. Add `USER nonroot` or `USER node` (for Node.js images).
- **Secrets in build args visible in history**: `docker build --build-arg SECRET=xxx` — the arg value is stored in image metadata. `docker history` reveals it. Use BuildKit secrets mount instead: `RUN --mount=type=secret,id=mysecret`.
- **Base image tag `latest` or version-only**: `FROM node:20` or `FROM node:latest` can change underneath. A new base image may introduce breaking changes or vulnerabilities. Pin to digest: `FROM node:20-alpine@sha256:...`.
- **COPY with overly broad source**: `COPY . .` includes everything not in `.dockerignore`. Git history (`.git/`), IDE configs, test files, local secrets all end up in the image.

## Platform Constraints

- **Architecture mismatch**: Image built on ARM Mac (`linux/arm64`) may not run on AMD64 servers. Use `docker buildx build --platform linux/amd64` for cross-platform builds.
- **Filesystem case sensitivity**: macOS is case-insensitive, Linux (Docker) is case-sensitive. `import './MyFile'` works locally but fails in container if file is `myfile.js`.
- **Host networking only on Linux**: `--network host` doesn't work on Docker Desktop (Mac/Windows). Container can't access host's `localhost` directly. Use `host.docker.internal` instead.
- **Temp file size limits**: Default `/tmp` size in some container runtimes is limited (64MB in some Kubernetes configs). Large temp file operations fail unexpectedly.

## Implementation Quality

- **No `.dockerignore`**: Build context includes everything. `.git` directory alone can be hundreds of MB. Build is slow and image is bloated.
- **Multiple `RUN` commands instead of chaining**: Each `RUN` creates a layer. `RUN apt-get update` then `RUN apt-get install` — the update cache is in a different layer and may be stale on rebuild. Chain: `RUN apt-get update && apt-get install -y pkg && rm -rf /var/lib/apt/lists/*`.
- **`EXPOSE` doesn't publish ports**: `EXPOSE 3000` in Dockerfile is documentation only. It does NOT make the port accessible. Still need `-p 3000:3000` at runtime.
