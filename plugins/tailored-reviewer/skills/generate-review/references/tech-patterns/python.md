# Python — Tech-Specific Bug Patterns

## Execution Flow

- **Mutable default argument**: `def add(item, lst=[])` — the list is created ONCE at function definition, shared across all calls. Appending to it accumulates across invocations. Use `lst=None` + `if lst is None: lst = []`.
- **Late binding in closures**: `funcs = [lambda: i for i in range(3)]` — all three lambdas return `2` (the final value of `i`). The variable `i` is captured by reference, not value. Fix: `lambda i=i: i`.
- **`except Exception` vs bare `except:`**: `except Exception` doesn't catch `KeyboardInterrupt` or `SystemExit` (correct). But bare `except:` catches everything including those. Never use bare except.
- **`finally` return overrides `try` return**: If both `try` and `finally` have `return`, the `finally` return wins. The `try` return value is silently discarded.
- **Generator exhaustion is silent**: Iterating a generator twice — second iteration yields nothing, no error. `list(gen)` works once, second `list(gen)` returns `[]`.
- **`asyncio.create_task` without reference**: If you don't store the Task, it can be garbage collected before completion. The coroutine may never finish, no error raised.

## Resource Management

- **File handle leak without `with`**: `f = open('file'); data = f.read()` — if an exception occurs between open and close, the handle leaks. Always use `with open(...) as f:`.
- **`__del__` is not guaranteed to run**: Python's finalizer is NOT like a destructor. It may not run if there are reference cycles. Don't rely on `__del__` for cleanup.
- **`requests` connection per call**: `requests.get()` creates a new TCP connection each time. For repeated calls to the same host, use `requests.Session()` to reuse connections.
- **Large list comprehension memory**: `[x**2 for x in range(10_000_000)]` allocates the entire list. Use generator expression `(x**2 for x in ...)` for iteration-only use.

## Concurrency

- **GIL prevents CPU parallelism**: `threading` does NOT speed up CPU-bound work. Threads run concurrently for I/O but serially for CPU. Use `multiprocessing` for CPU-bound tasks.
- **`asyncio.run()` can't be nested**: Calling `asyncio.run()` inside an already-running event loop raises `RuntimeError`. Common in Jupyter notebooks and when integrating async into sync code.
- **`dict` is not thread-safe for compound operations**: Individual reads/writes are atomic due to GIL, but check-then-update (`if key not in d: d[key] = val`) is NOT. Use `threading.Lock`.
- **`time.sleep()` in async code**: Blocks the entire event loop. Use `await asyncio.sleep()`. No warning, just all concurrent coroutines freeze.

## Security

- **Pickle deserializes arbitrary code**: `pickle.loads(untrusted_data)` executes arbitrary Python during deserialization. Never unpickle untrusted data. Use JSON, MessagePack, or Protocol Buffers.
- **Shell injection via `subprocess` with `shell=True`**: `subprocess.run(f"echo {user_input}", shell=True)` — user input is interpreted by the shell. Use list form: `subprocess.run(["echo", user_input], shell=False)`.
- **`yaml.load()` without safe Loader**: Default `yaml.load()` can instantiate arbitrary Python objects. Always use `yaml.safe_load()`.
- **String formatting with user-controlled dicts**: `"Hello {name}".format(**user_dict)` — crafted keys like `__class__`, `__globals__` can access internal object attributes.

## Platform Constraints

- **`import` executes top-level code**: Importing a module runs all code at module level. Database connections, API clients, file operations at top level execute on import. Causes issues in serverless cold starts and testing.
- **Shadow stdlib with local files**: A local file named `json.py`, `email.py`, `random.py` shadows the stdlib module. `import json` imports YOUR file, not the standard library. Cryptic errors.
- **Python 3.x string encoding**: `str` is always Unicode. But `bytes` from network/file is not. Missing `.decode('utf-8')` or wrong encoding = `UnicodeDecodeError` only on non-ASCII input (works fine in testing with ASCII).

## Implementation Quality

- **`is` vs `==`**: `is` checks identity (same object), `==` checks equality. `x is None` is correct idiom. But `x is 1` works for small integers (-5 to 256) due to CPython interning, fails for larger numbers. Always use `==` for value comparison.
- **`datetime.utcnow()` returns naive datetime**: No timezone info. Use `datetime.now(timezone.utc)` for timezone-aware UTC. Mixing naive and aware datetimes raises `TypeError`.
- **Class variable shared across instances**: `class Foo: items = []` — all instances share the SAME list. `self.items.append(x)` mutates the shared list. Define mutable attributes in `__init__`.
- **`==` on floats**: `0.1 + 0.2 == 0.3` is `False`. Use `math.isclose()`.
- **`dict.get(key)` returns `None` silently**: Can't distinguish "key exists with value None" from "key missing" using `.get()` alone. Use `key in d` when None is a valid value.
- **`or` for default values gotcha**: `x = val or default` — if `val` is `0`, `""`, `[]`, or `False`, these are falsy and get replaced by default. Use `x = val if val is not None else default` for None-only check.
- **Modifying dict while iterating**: `for k in d: if cond: del d[k]` raises `RuntimeError`. Use `for k in list(d.keys())` or build a separate list of keys to delete.
- **Deleting list items while iterating**: `for i, v in enumerate(lst): if cond: lst.pop(i)` skips elements. Indices shift after deletion. Iterate in reverse or use list comprehension.
- **Loop variable leaks to enclosing scope**: `for x in range(3): pass; print(x)` prints `2`. The loop variable `x` persists after the loop. Name collision with other variables in the same scope.
- **Enclosing scope assignment causes UnboundLocalError**: `x = 10; def foo(): print(x); x = 20` — `print(x)` raises `UnboundLocalError` because the later `x = 20` makes `x` local in the entire function. Use `nonlocal x`.
- **`tuple` with one element needs trailing comma**: `x = (1)` is `int`, not `tuple`. Must write `x = (1,)`. Common when constructing SQL parameter tuples.
- **`__eq__` without `__hash__`**: Defining `__eq__` makes the class unhashable (can't use in sets/dict keys) unless `__hash__` is also defined. Silent failure when adding to a set.
