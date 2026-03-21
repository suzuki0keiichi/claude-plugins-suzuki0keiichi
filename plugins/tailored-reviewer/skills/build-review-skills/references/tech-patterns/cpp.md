# C++ — Tech-Specific Bug Patterns

## Execution Flow

- **Undefined behavior is silent**: Signed integer overflow, null pointer dereference, out-of-bounds array access — all UB. Compiler may optimize away checks, assume UB doesn't happen, or produce arbitrary results. No crash guaranteed.
- **Static initialization order fiasco**: Global/static objects in different translation units have undefined initialization order. If A's constructor uses B, and B isn't initialized yet = crash or garbage. Use function-local statics or lazy initialization.
- **Exception in destructor**: Throwing an exception during stack unwinding (another exception in flight) calls `std::terminate()`. Destructors must be noexcept. Forgetting this = unpredictable process termination.
- **Virtual function call in constructor/destructor**: Calls the BASE class version, not the derived override. The derived part isn't constructed yet (constructor) or already destroyed (destructor). No error, just wrong function called.
- **`std::move` doesn't move**: `std::move(x)` is just a cast to rvalue reference. The actual move happens when a move constructor/assignment accepts it. Using `x` after `std::move(x)` is valid but the object is in "moved-from" state (valid but unspecified).
- **Order of evaluation**: `f(a(), b())` — order of `a()` and `b()` is unspecified (not undefined, but unspecified). If both have side effects, behavior varies between compilers.

## Resource Management

- **Rule of 3/5/0**: If you define destructor, copy constructor, or copy assignment, you likely need all three (Rule of 3) or all five (add move constructor, move assignment). Missing one = resource leak or double-free.
- **`new` without `delete` / `new[]` without `delete[]`**: `delete` on `new[]` memory is UB. `delete[]` on `new` memory is UB. Mix these = memory corruption. Use smart pointers to avoid manual management.
- **`shared_ptr` circular reference**: Two objects holding `shared_ptr` to each other = memory leak (reference count never reaches 0). Use `weak_ptr` to break cycles.
- **RAII violation in C-style APIs**: C libraries (OpenSSL, SQLite) return raw pointers requiring manual cleanup. Wrapping in `unique_ptr` with custom deleter ensures cleanup on exception paths.
- **Iterator invalidation**: `std::vector::push_back` may reallocate, invalidating ALL iterators. Erasing from `std::map` during iteration invalidates only the erased iterator. Each container has different rules.
- **Stack overflow from deep recursion**: No stack growth in C++. Default stack size ~1-8MB. Deep recursion or large stack-allocated arrays = silent crash. Use heap allocation for large data.

## Concurrency

- **Data race = undefined behavior**: Unlike Java, concurrent read-write to the same non-atomic variable is UB in C++. Not "just a wrong value" — the compiler may optimize based on single-threaded assumptions.
- **`mutex` lock order deadlock**: Thread 1 locks A then B, Thread 2 locks B then A = deadlock. Use `std::scoped_lock(a, b)` to lock multiple mutexes atomically.
- **`std::shared_ptr` refcount is thread-safe, pointed object is not**: Multiple threads can copy/destroy `shared_ptr` safely. But reading/writing the pointed-to object concurrently is still a data race.
- **`volatile` is NOT for threading**: `volatile` prevents compiler optimization of memory reads but does NOT provide atomicity or ordering. Use `std::atomic<T>` for thread-safe operations.
- **False sharing**: Two `std::atomic` variables on the same cache line cause cache ping-pong between CPU cores. Use `alignas(64)` or `std::hardware_destructive_interference_size` to separate.
- **Detached thread outliving main**: `std::thread::detach()` — if main() returns while detached thread is running, behavior is undefined (global destructors run while thread is active). Join or ensure completion before exit.

## Security

- **Buffer overflow**: `strcpy`, `sprintf`, `gets` — no bounds checking. Use `strncpy`, `snprintf`, `fgets` or `std::string`. Stack buffer overflow = code execution vulnerability.
- **Format string vulnerability**: `printf(user_input)` — user can read/write arbitrary memory with `%x`, `%n`. Always use `printf("%s", user_input)`.
- **Use-after-free**: Accessing memory after `delete`/`free`. May work briefly (memory not yet reused), then corrupt data when memory is reused. Use-after-free is the #1 class of C++ vulnerabilities.
- **Integer overflow in size calculations**: `size_t n = user_count * sizeof(struct)` — if multiplication overflows, allocated buffer is too small. Use checked arithmetic.
- **Uninitialized memory**: Local variables and heap allocations are NOT zero-initialized. Reading uninitialized memory = information leak or UB. Always initialize.

## Platform Constraints

- **ABI compatibility**: Different compiler versions, standard library versions, or compile flags can produce incompatible object files. Mixing is UB. All linked objects must use compatible ABI.
- **`sizeof` varies by platform**: `sizeof(long)` is 4 on Windows, 8 on Linux. `sizeof(pointer)` is 4 on 32-bit, 8 on 64-bit. Use fixed-width types (`int32_t`, `int64_t`) for portable code.
- **Endianness**: Network protocols and file formats may assume big-endian. x86 is little-endian. Forgetting `ntohl`/`htonl` = corrupt data on the wire.
- **Thread stack size**: Default varies by OS (1MB Linux, 8MB macOS). Embedded/RTOS systems may have 4-64KB stacks. Large local arrays overflow the stack with no warning.

## Implementation Quality

- **Implicit conversions**: `void foo(bool b)` called as `foo(ptr)` — pointer implicitly converts to bool. `foo(42)` also works. Use `explicit` constructors and conversion operators.
- **`const` correctness**: Non-const reference to temporary is UB (lifetime extension only works for const reference). `std::string& s = getString()` = dangling reference. `const std::string& s = getString()` extends lifetime.
- **Slicing**: `Derived d; Base b = d;` copies only the Base part. Derived data is lost. Passing derived object by value to function taking base = slicing.
- **`auto` type deduction surprises**: `auto x = {1, 2, 3}` is `std::initializer_list<int>`, not `std::vector`. `auto& x = someFunc()` — if `someFunc` returns by value, `x` is a dangling reference.
- **Header-only vs compiled**: Templates must be in headers (or explicit instantiation). Putting template implementation in .cpp = linker error. But large headers increase compile time.
