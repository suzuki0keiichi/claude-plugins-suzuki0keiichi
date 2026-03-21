# TypeScript — Tech-Specific Bug Patterns

## Execution Flow

- **`as` assertion is a lie to the compiler**: `const x = userInput as User` does ZERO runtime validation. If `userInput` doesn't match `User`, no error — just wrong types at runtime. Use Zod or runtime validators at system boundaries.
- **Optional chaining short-circuits the whole expression**: `obj?.a.b.c` — if `obj` is null, the entire expression is `undefined`. But `obj.a?.b.c` — if `a` is null, only `.b.c` is skipped. Misplacing `?` changes what gets short-circuited.
- **`Promise<void>` callbacks are silently dropped**: A function expecting `() => void` callback accepts `() => Promise<void>` without error. The returned Promise is ignored, async errors are lost.
- **Non-null assertion `!` hides runtime errors**: `user!.name` tells TypeScript "trust me, not null." At runtime, if null, you get `Cannot read property 'name' of null` with no helpful stack trace pointing to the assertion.

## Security

- **`strictNullChecks: false` (off by default in some configs)**: Without strict null checks, `null` and `undefined` bypass ALL type narrowing. A variable typed `string` can be `null` at runtime with zero warnings. Check `tsconfig.json`.
- **Type-only imports stripped at runtime**: `import type { Foo }` is erased. If you use it as a runtime value (e.g., `instanceof Foo`), it's `undefined`. No build error if `isolatedModules` is off.
- **`enum` reverse mapping leaks**: Numeric enums create reverse mappings: `enum Status { Active = 0 }` → `Status[0] === "Active"`. If enum values are used as access keys, users can map numbers to names unexpectedly.

## Implementation Quality

- **`Object.keys()` returns `string[]`, not `keyof T`**: By design — objects can have more keys at runtime than TypeScript knows. `Object.keys(typedObj).forEach(key => typedObj[key])` — `key` is `string`, indexing fails. Use a type guard or explicit cast.
- **Index signature makes all properties optional-like**: `interface Dict { [key: string]: number }` — accessing `dict.nonexistent` returns `undefined` at runtime but TypeScript says it's `number` (unless `noUncheckedIndexedAccess` is on). Silent undefined propagation.
- **`satisfies` vs `as` vs type annotation**: `x satisfies T` checks but preserves the narrower type. `x as T` widens/narrows unsafely. Type annotation `const x: T = ...` widens. Using `as` when you meant `satisfies` loses type narrowing.
- **Discriminated union exhaustiveness**: `switch` on a discriminated union without `default` doesn't error if a case is missing (unless you use `never` check). Adding a new variant to the union doesn't cause compile errors at existing switches.
- **`readonly` is shallow**: `readonly items: string[]` prevents reassigning `items` but NOT mutating the array (`items.push('x')` works). Use `ReadonlyArray<string>` or `readonly string[]` for the array itself.
- **Generic default inference**: `function foo<T = string>(x: T)` — calling `foo(123)` infers `T = number`, NOT `string`. The default only applies when `T` can't be inferred. Surprising when you expect the default to constrain.
- **`catch` clause variable is `unknown` (strict) or `any`**: With `useUnknownInCatchVariables: true`, `catch(e)` types `e` as `unknown`. Without it, `e` is `any`. Either way, accessing `e.message` without type narrowing is unsafe.
