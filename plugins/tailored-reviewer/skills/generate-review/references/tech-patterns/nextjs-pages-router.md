# Next.js Pages Router — Tech-Specific Bug Patterns

## Execution Flow

- **getServerSideProps not re-running on client navigation**: Client-side route changes via `next/link` or `router.push` DO call getServerSideProps on the server. But `getStaticProps` pages won't refetch unless revalidation triggers. Know which data fetching method each page uses.
- **Middleware runs on ALL routes by default**: `middleware.ts` matcher config determines scope. Missing or overly broad matchers cause unintended interception of static assets, API routes, or `_next/` paths.
- **API route handler method dispatch**: Pages Router API routes receive all HTTP methods. Missing method check (`if (req.method !== 'POST')`) means GET requests can trigger mutations.
- **`getServerSideProps` redirect vs return**: Returning `{ redirect: { destination: '/login' } }` still renders the component briefly before redirect. Sensitive data in the component may flash.

## Resource Management

- **Prisma client singleton**: Must use singleton pattern (`global.prisma`) in development to avoid connection pool exhaustion from hot reloading. Production: single instance per process.
- **API route cold start**: Each API route is a separate serverless function. Heavy imports (Prisma, OpenAI SDK) in every route = slow cold starts. Consider shared module initialization.

## Concurrency

- **No built-in request queuing**: Multiple simultaneous API requests to the same endpoint are handled independently. Shared in-memory state (e.g., rate limit counters in `Map`) is per-process and lost on restart.
- **`getServerSideProps` and API route race**: If a page calls its own API route from `getServerSideProps`, this creates a self-request that may deadlock under high concurrency on single-threaded deployments.

## Security

- **API routes exposed by default**: Any file in `pages/api/` becomes a public endpoint. No built-in auth middleware. Every route must explicitly check authentication.
- **`req.query` type is `string | string[]`**: Accessing `req.query.id` without checking for array can cause unexpected behavior. Always normalize: `const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id`.
- **CORS not configured by default**: API routes accept requests from any origin. If cookies are used for auth, this may not matter (SameSite), but explicit CORS headers are recommended for public APIs.
- **`next.config.js` headers/rewrites**: Security headers defined here apply to pages but NOT to API routes by default on some hosting. Verify security headers reach API routes.

## Platform Constraints

- **Vercel serverless function size limit**: 50MB compressed. Large dependencies (sharp, puppeteer) may exceed this.
- **Vercel function timeout**: 10s (Hobby), 60s (Pro), 300s (Enterprise). Long-running API operations need background processing.
- **ISR revalidation race**: Multiple requests during revalidation can trigger multiple rebuilds. `revalidate` is a minimum, not exact interval.

## Implementation Quality

- **`pages/` vs `app/` confusion**: Mixing Pages Router and App Router in the same project causes routing conflicts. Files in both `pages/` and `app/` for the same route = undefined behavior.
- **`_app.tsx` vs layout**: Pages Router uses `_app.tsx` for global layout. Forgetting to wrap providers here means they're missing on every page.
- **Dynamic import for client-only**: Components using `window` or `document` must use `next/dynamic` with `ssr: false`. Otherwise, SSR crashes.
