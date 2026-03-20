# Next.js App Router — Tech-Specific Bug Patterns

## Execution Flow

- **`redirect()` throws internally**: Calling `redirect('/login')` inside a try/catch swallows the redirect. The redirect never happens and the page renders normally. Same for `notFound()`. Never wrap these in try/catch.
- **Server Component re-renders on every navigation**: Unlike Client Components, Server Components re-execute on every request. Side effects in Server Components (logging, incrementing counters) run more often than expected.
- **`cookies()` and `headers()` are async (Next.js 16)**: Forgetting `await` returns a Promise object, not the actual value. Code silently proceeds with a truthy Promise instead of the cookie value. No runtime error.
- **`useSearchParams()` forces client rendering up the tree**: Without a Suspense boundary, the entire page becomes client-rendered. No build error — just silently loses SSR benefits.
- **Server Actions execute sequentially per client**: Multiple server action calls from the same client are queued, not parallel. A slow action blocks all subsequent ones from that browser tab.
- **`revalidatePath`/`revalidateTag` only works in Server Actions and Route Handlers**: Calling from a Server Component has no effect. No error thrown.
- **`generateStaticParams` + `dynamicParams = true` (default)**: Pages not in `generateStaticParams` are still dynamically rendered. Setting `dynamicParams = false` returns 404 for unknown params. Forgetting this means every arbitrary URL is "valid."

## Resource Management

- **Server Components can't use hooks**: No `useState`, `useEffect`, `useContext`. Importing a component that uses hooks without `'use client'` directive crashes at build time with a confusing error.
- **`fetch` in Server Components is auto-deduped**: Two `fetch()` calls to the same URL in the same render return the same result (single request). Surprising when you expect separate calls. Also, POST requests are NOT deduped.
- **Route Handler + Server Component on same route**: `app/api/data/route.ts` and `app/api/data/page.tsx` conflict. Route Handler takes precedence for matching HTTP methods.

## Concurrency

- **Parallel data fetching requires explicit `Promise.all`**: Sequential `await` in Server Components creates a waterfall. Must use `const [a, b] = await Promise.all([fetchA(), fetchB()])` for parallel.
- **Race between `revalidatePath` and client-side Router Cache**: After a Server Action calls `revalidatePath`, the client's Router Cache may still serve stale data. Call `router.refresh()` on the client, or set `staleTimes` to 0.

## Security

- **Server-only code leaking to client bundle**: Importing a module with secrets in a Client Component includes it in the browser bundle. Use `server-only` package to error at build time: `import 'server-only'` at top of server modules.
- **Server Action input is user-controlled**: Arguments to Server Actions come from the client. They are NOT type-safe at runtime. Must validate with Zod or similar. A `deleteUser(userId)` action can receive ANY userId from a crafted request.
- **`headers()` spoofing**: `headers().get('x-forwarded-for')` is set by the reverse proxy. In local dev or misconfigured proxy, this header is client-controlled. Don't trust for auth decisions.
- **Route Handler auth bypass via HTTP method**: If Route Handler only checks auth in POST but exports GET too, the GET handler is unauthenticated. Each exported method is independent.

## Platform Constraints

- **Server Actions 1MB body limit**: Default limit for Server Action payloads. Large form submissions or file uploads silently fail. Override with `serverActions.bodySizeLimit` in next.config.
- **`'use client'` is a boundary, not a toggle**: All imports of a `'use client'` module are client-side, including their dependencies. A large shared utility imported by a Client Component ends up in the client bundle even if most of it is server-only.
- **Edge Runtime limitations**: `export const runtime = 'edge'` restricts to Web APIs only. `fs`, `crypto` (Node), `Buffer` unavailable. Errors only at runtime, not build time.

## Implementation Quality

- **Props drilling through Server → Client boundary**: Props passed from Server Components to Client Components must be serializable (no functions, no classes, no Date objects). `Date` becomes a string silently. Functions are stripped.
- **Missing `loading.tsx`**: Without it, navigation to a Server Component page shows nothing until the server responds. Users see a frozen screen with no indication of loading.
- **`error.tsx` must be Client Component**: Error boundaries require `'use client'`. A Server Component `error.tsx` doesn't catch errors. No build warning.
- **Metadata exports don't work in Client Components**: `export const metadata` or `export function generateMetadata` in a `'use client'` file is silently ignored. SEO tags disappear.
