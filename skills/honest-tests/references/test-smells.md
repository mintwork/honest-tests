# Test smell catalog

Each entry: what it looks like, why the test can't fail, the honest version, and how to verify a
finding in Phase 2 (including known false positives).

---

## no-assertions (error)

```ts
it('applies a percentage discount', () => {
  applyDiscount(100, 10); // runs the code, checks nothing
});
```

**Why it's fake:** the test fails only if the code crashes. A wrong result passes.

**Honest:**

```ts
it('takes 10% off', () => {
  expect(applyDiscount(100, 10)).toBe(90);
});
```

**Verify:** look for assertions hidden in helpers the detector didn't recognize. Calls named
`expect*`, `assert*`, `verify*`, `check*`, `ensure*`, `should*`, `validate*`, and `.expect(...)` (supertest)
already count, as do node:test `t.assert.*`, tap/tspl-style `t.equal(...)`, Deno `@std/assert`, a `done`
callback the code calls back (`bus.on('x', () => done())`), and `t.plan(n)` / `expect.assertions(n)`.
If the test genuinely asserts "does not throw", rewrite it as
`expect(() => fn()).not.toThrow()` so the intent is explicit.

---

## tautological-assertion (error)

```ts
const result = subtotal(items);
expect(result).toBe(result);           // value vs itself
expect(format(5)).toEqual(format(5));  // recomputed with the same code
expect(list).toHaveLength(list.length) // expected derived from actual
expect(true).toBe(true);               // constant
```

**Why it's fake:** the outcome is decided before any code under test runs.

**Honest:** compare against an independently known value: `expect(subtotal(items)).toBe(35)`.

**Verify:** almost never a false positive. One exception: deliberately checking referential identity of
a memoized call (`expect(memo(a)).toBe(memo(a))`) — that is a real check; mark as `accepted` and add a
comment explaining it.

---

## asserts-on-mock (error)

```ts
const qualifies = vi.fn().mockReturnValue(true);
expect(qualifies(10, true)).toBe(true); // you told it to return true
```

```ts
vi.mocked(checkoutTotal).mockReturnValue(42);
expect(checkoutTotal(items, 0, false)).toBe(42);
```

**Why it's fake:** it verifies the mocking library, not your code.

**Honest:** call the *real* unit, which uses the mock as a dependency, and assert on what the unit
produces. Assert on the mock only for interactions:

```ts
const repo = { find: vi.fn().mockResolvedValue({ name: 'Ada' }) };
const svc = new UserService(repo);
expect(await svc.greet(1)).toBe('Hello, Ada');
expect(repo.find).toHaveBeenCalledWith(1);
```

**Verify:** confirm the asserted call is the mock itself (or a variable holding its direct result),
not the real unit that happens to share a name.

---

## asserts-on-own-literal (error)

```ts
it('accepts an S3 provider config', () => {
  const p: ProviderConfig = { service: 's3', region: 'eu-west-1' };
  expect(p.service).toBe('s3');          // reads back the literal it just wrote
  expect(p).toEqual({ service: 's3', region: 'eu-west-1' });
});
```

**Why it's fake:** nothing from the code under test is involved — the value is built from literals in
the test and read straight back. Common in "type tests": TypeScript types don't exist at runtime, so
`const p: ProviderConfig = {...}` followed by `expect(p.service)` checks nothing the compiler hasn't
already checked, and nothing at runtime at all.

**Honest:** pass the literal through the code under test and assert on what comes out:

```ts
expect(resolveEndpoint({ service: 's3', region: 'eu-west-1' })).toBe('https://s3.eu-west-1.amazonaws.com');
```

For a genuinely type-level contract, use a compile-time check instead of a runtime assertion:
`expectTypeOf(cfg).toMatchTypeOf<ProviderConfig>()`, `tsd`, or a `// @ts-expect-error` line that breaks
the build when the type gets too loose.

**Verify:** the rule only fires when the asserted value traces back purely to literals declared in the
same test (object/array/template literals, operators, own-property reads) and the binding is never
passed to a function, mutated or reassigned. Calls, `new`, imports, parameters and outer variables all
stop it, as do reads that could reach the prototype (`{}.polluted`, `'x' in obj`, `toHaveProperty`) and
custom matchers. If a hit is a deliberate sanity check of the test's own fixture data, delete it or
mark it `accepted`.

---

## never-failing-assertion (error)

```ts
expect(config).toBeTruthy;                        // matcher never called
expect(load());                                   // no matcher at all
expect(load()).resolves.toBe(1);                  // not awaited/returned
expect(typeof value).toBeDefined();               // typeof is always a string
expect({ a: 1 }).toBeTruthy();                    // objects are always truthy
expect(items.length).toBeGreaterThanOrEqual(0);   // lengths are never negative
expect(new Cart()).toBeDefined();                 // constructors always return
```

**Why it's fake:** structurally unable to fail.

**Honest:** call the matcher, `await` async matchers, assert the exact value
(`expect(config).toEqual({ currency: 'USD' })`, `expect(items).toHaveLength(2)`).

**Verify:** for un-awaited `.resolves/.rejects`, check whether the promise is returned or awaited via a
variable later (`const p = expect(...).resolves...; await p;`) — that's a false positive.

---

## swallowed-assertion (error)

```ts
try {
  expect(applyDiscount(100, 20)).toBe(70); // wrong, but...
} catch {
  // ...the AssertionError is caught here and the test passes
}
```

**Why it's fake:** assertion failures are exceptions; catching them hides the failure.

**Honest:** remove the `try/catch`. For error paths: `expect(() => f()).toThrow(RangeError)`.

**Verify:** a `catch` that rethrows (`throw e`) or calls `fail()` is not flagged. If the catch logs and
then re-asserts something, read carefully — usually still confirmed.

---

## catch-only-assertion (error, warning if other assertions exist)

```ts
try {
  applyDiscount(100, 150);
} catch (e) {
  expect(e).toBeInstanceOf(RangeError); // never runs if nothing throws
}
```

**Why it's fake:** if the code stops throwing, the catch is skipped and the test passes with zero
assertions.

**Honest:** `expect(() => applyDiscount(100, 150)).toThrow(RangeError)`. If you need the error object,
add `expect.assertions(1)` at the top, or `expect.fail('should have thrown')` after the call.

---

## mocked-unit-under-test (error; warning for partial mocks)

```ts
// checkout.test.ts
import { checkoutTotal } from '../src/checkout';
vi.mock('../src/checkout'); // the thing under test is now a stub
```

```ts
import * as cart from '../src/cart';
vi.spyOn(cart, 'total').mockReturnValue(3); // replaces the real implementation
```

**Why it's fake:** every assertion runs against the mock. The real code never executes.

**Honest:** import the real module; mock its dependencies (`vi.mock('../src/tax')`, HTTP clients,
clocks).

**Verify:** the detector matches the test file name (`cart.test.ts`) to the mocked module name
(`./cart`, `../src/cart/index`). If the file is misnamed and actually tests something else, it's a
false positive. Partial mocks (`importOriginal`/`requireActual`) are warnings — check whether the
overridden export is the one being tested.

---

## excessive-mocking (warning)

Five or more `vi.mock`/`jest.mock` calls in one file. Little real code remains under test; the test
mostly checks that mocks are wired to each other. **Verify:** read what is left unmocked. If the unit
is a thin orchestrator, recommend an integration test at the boundary instead.

---

## snapshot-only (warning)

```ts
it('renders the cart', () => {
  expect(render(cart)).toMatchSnapshot();
});
```

**Why it's weak:** the first run records whatever the code outputs — bugs included — and later runs
only detect *change*, not *wrongness*. Agents also "fix" failing snapshots with `-u` reflexively.

**Honest:** add at least one explicit assertion on what matters (`toContain('Total: $35')`), keep the
snapshot as a change detector if useful.

**Verify:** inline snapshots of small, reviewed values (`toMatchInlineSnapshot('true')`) are closer to a
literal assertion; check whether the recorded value is actually correct.

---

## conditional-assertion (warning)

```ts
const cost = shippingCost(20, false);
if (cost > 0) {
  expect(cost).toBeGreaterThan(0);
}
```

**Why it's weak:** when the guard is false the test passes with nothing checked.

**Honest:** assert unconditionally on the exact value (`expect(shippingCost(20, false)).toBe(5)`).
Split data-dependent branches into separate tests.

---

## focused-test (error) / skipped-test (warning)

`.only`, `fit`, `fdescribe` silently disable every other test in the file. `.skip`, `xit`, `xdescribe`
inflate the test count while verifying nothing. `skipIf/runIf` are not flagged.

**Honest:** remove `.only`; fix or delete skipped tests, or convert to `it.todo('...')` with an issue.

---

## reimplemented-algorithm (warning)

```ts
expect(total(price, qty)).toBe(price * qty * (1 + TAX)); // the code's formula, copied
const r = offset(page);
expect(r).toBe((page.number - 1) * page.size);
```

**Why it's weak:** the expected value is the unit's formula rewritten over the same inputs. If the
formula is wrong (`1 - TAX`, an off-by-one in `page.number - 1`), the test computes the same wrong
answer and passes.

**Honest:** pick concrete inputs, work the answer out by hand, assert the literal:
`expect(total(10, 3)).toBe(36)`.

**Verify:** the rule fires only when the actual value is a call with arguments (directly or via
`const r = f(...)`), the expected value is plain numeric arithmetic (`+ - * / % **`, `Math.*`, no
strings, no other calls), and it reads one of the call's own inputs. Literal arithmetic
(`toBe(100 - 20)`), relationships (`toBe(before.length + 1)`), `a + b` over names only (could be
string concatenation) and expected values built from other functions are never flagged. A property-based
test that compares against an *independent* reference implementation is fine: mark it `accepted`.

---

## oracle-copied-from-output (warning)

```ts
expect(quantile(prices, 0.5)).toEqual([2.9000000000000004, 3.2]);
expect(cartTotal(items)).toBe(79.98999999999999);
```

**Why it's weak:** nobody derives `2.9000000000000004` by hand. The rounding noise shows the expected
value was copied from a run of the code, so the test pins whatever the code computes today, bugs
included, and breaks on any harmless change to the order of floating-point operations.

**Honest:** derive the value independently and compare with a tolerance:
`expect(quantile(prices, 0.5)[0]).toBeCloseTo(2.9, 10)`.

**Verify:** the rule only looks for floats with rounding noise (12+ decimals, 13+ significant digits,
ending in a run of zeros or nines plus a stray digit or two). Plain long decimals such as
`14.142135623730951` aren't flagged (they may come from a reference table), nor are `toBeCloseTo`,
negated assertions, round trips whose input contains the same digits (`parse('0.30000000000000004')`) or
literal-only subjects. It can't see copied integers, strings or objects — check those manually. If the
value comes from an external reference (NumPy, a spec's test vectors), mark it `accepted` and say so in
a comment.

---

## weak-called-assertion (info; warning when it's the test's only kind of check)

```ts
const save = vi.fn();
it('saves the order', () => {
  submit(order, save);
  expect(save).toHaveBeenCalledWith({ id: 1, total: 35 });
});
it('saves edited orders', () => {
  submit(edit(order), save);
  expect(save).toHaveBeenCalled(); // passes whatever was saved
});
```

**Why it's weak:** `toHaveBeenCalled()` passes when the code calls the dependency with the wrong
arguments. The other test proves the arguments are knowable and checkable.

**Honest:** `expect(save).toHaveBeenCalledWith({ id: 1, total: 40 })` (or `expect.objectContaining`
for the fields that matter).

**Verify:** the rule only fires on mocks shared between tests (file-level, describe-level or imported
module mocks) whose arguments another test checks (`toHaveBeenCalledWith(...)` with arguments,
`mock.calls[0][0]`), and only when this test checks none of them. Mocks a test declares itself
(`const onClose = vi.fn()`) are never matched against other tests by name, so most bare
`toHaveBeenCalled()` calls are not flagged — check the rest manually. False positives: a test whose
point is only *that* the call happens (the arguments are covered by the other test) — mark `accepted`.

---

## Beyond the detector (check these manually in Phase 1)

These are common in AI-written suites but need judgement:

- **Oracle copied from output** — the expected literal was pasted from a run of the code (`toBe(79.99)`
  with no derivation). Ask: where did this number come from? Recompute it by hand.
  `oracle-copied-from-output` only catches floats with rounding noise.
- **Re-implemented algorithm** — the test computes the expected value with the same formula as the code
  (`expect(total).toBe(price * qty * (1 - d))`). Bugs in the formula are copied into the test.
  `reimplemented-algorithm` only catches numeric formulas over the call's own inputs.
- **Asserting irrelevant details** — tests pass/fail on log text or call order nobody depends on, while
  the business result is unchecked.
- **Happy path only** — no boundary (`>=` vs `>`), empty input, or error path tests. Mutation testing
  exposes these as surviving `>=` → `>` mutants.
- **Test name lies** — `'rejects invalid input'` but no invalid input is passed.
- **Weak matchers everywhere** — `toBeDefined()`, `toBeTruthy()`, `toHaveBeenCalled()` (without args;
  `weak-called-assertion` only flags shared mocks), `expect.anything()` where an exact value is known.
- **Assertion-free type tests** — `const x: Foo = make()` relies on the type checker, which test runners
  usually skip.
