# React — Tech-Specific Bug Patterns

## Execution Flow

- **Hooks called conditionally**: `if (cond) { useState() }` — hooks must be called in the same order every render. Conditional hooks cause state mismatch between renders. No runtime error in production build, just corrupted state.
- **`useEffect` cleanup timing**: Cleanup runs BEFORE the next effect, not on unmount only. When deps change, cleanup of previous effect runs after new render but before new effect.
- **`setState` in render**: Calling `setState` during render causes infinite re-render loop. But `setState` in `useEffect` runs after render. Confusing when refactoring from one to the other.
- **`useEffect` with empty deps runs twice in StrictMode**: React 18 StrictMode intentionally double-invokes effects in development. If effect has side effects (API call, subscription), they fire twice. Not a bug — it reveals missing cleanup.
- **`useRef` changes don't trigger re-render**: `ref.current = newValue` silently updates without re-rendering. Using ref where state is needed = stale UI.
- **Event handler stale closure**: `useEffect(() => { window.addEventListener('click', handler) }, [])` — `handler` captures state from initial render forever. New state values never reflected in the handler.

## Resource Management

- **Missing `useEffect` cleanup**: `useEffect(() => { const id = setInterval(...) }, [])` without `return () => clearInterval(id)` leaks intervals on unmount. Common with timers, subscriptions, event listeners.
- **Fetch in useEffect without abort**: `useEffect(() => { fetch(url).then(setData) }, [url])` — if `url` changes rapidly, old responses arrive after new ones, overwriting correct data with stale data. Use `AbortController`.
- **`useMemo`/`useCallback` with wrong deps**: Missing a dependency means the memoized value is stale. Including an unstable dependency (new object/array every render) means it never memoizes.

## Concurrency

- **Batch state updates in async**: React 18 batches ALL state updates (including in `setTimeout`, `fetch.then`). But React 17 only batches in event handlers. Upgrading React version changes when re-renders happen.
- **Concurrent rendering tearing**: External mutable stores (global variables, refs) can show inconsistent values during concurrent render. Use `useSyncExternalStore` for external state.

## Security

- **`dangerouslySetInnerHTML` with user content**: Renders raw HTML without sanitization. Must sanitize with DOMPurify or similar. Even HTML from your own API can contain XSS if the data source was compromised.
- **Props passed to DOM elements**: Custom props on native elements (`<div userId={123}>`) appear in the DOM, potentially leaking data. Use `data-` prefix or filter before spreading.

## Implementation Quality

- **Object/array as `useEffect` dependency**: `useEffect(() => {}, [{ a: 1 }])` — new object every render, effect runs every render. Deps compare by reference, not value. Destructure to primitives or use `useMemo`.
- **`key` prop on lists**: Missing `key` causes React to reuse DOM nodes incorrectly. Using array index as `key` on reorderable lists causes state to stick to wrong items (checkboxes, input values).
- **`children` prop falsy rendering**: `{count && <Component />}` when `count` is `0` renders "0" on screen. Use `{count > 0 && <Component />}` or ternary.
- **Controlled vs uncontrolled input switching**: Setting `value` then later setting it to `undefined` switches from controlled to uncontrolled. React warns but the input becomes editable with stale state.
