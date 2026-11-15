---
name: honest-tests
description: Write and audit tests that actually verify behavior instead of tests that merely pass. Use when writing, generating, reviewing or fixing unit tests (vitest, jest, mocha, node:test, bun, deno, pytest), when asked to "add tests", "increase coverage", "audit/review the tests", or before claiming a change is tested. Detects fake tests (tautological assertions, no assertions, asserting on mocks you configured or on literals the test just built, mocking the unit under test, snapshot-only tests, try/catch that swallows failures, assertions that can never fail, leftover .only/.skip) and proves weak tests with lightweight mutation testing via the `honest-tests` CLI.
license: MIT
metadata:
  version: "0.2.0"
  cli: "npx @mintwork/honest-tests"
---

# Honest Tests

A test is honest only if **it fails when the behavior it names is broken**. Everything in this skill
serves that one rule. Green is not the goal; *a test that can go red for the right reason* is.

AI-written test suites fail this rule in predictable ways: they assert that a value equals itself,
assert on the return value of a mock they just configured, mock the very module under test, wrap
assertions in `try/catch`, or never assert at all. They pass forever and protect nothing.

Use this skill in two modes:

- **Writing tests** — follow the rules below, then self-audit before you report done.
- **Auditing tests** — run the phased procedure: detect → verify → report (→ fix, if asked).

## Hard rules (never break these)

1. **Never weaken an assertion to make a test pass.** If a test fails, first assume the *code* may be
   wrong. Changing `toBe(70)` to `toBe(80)` because the output was 80 is only allowed after you have
   independently confirmed 80 is correct (spec, hand calculation, domain rule).
2. **The expected value must come from somewhere other than the code under test.** Hand-computed
   literals, fixtures, or a spec — never `expect(fn(x)).toBe(fn(x))` and never a value copied from a
   run of the code you are testing without checking it.
3. **Never mock the unit under test.** Mock only its boundaries (network, DB, clock, randomness,
   filesystem, other services). If you must mock half the module to test it, say so — that is a design
   smell to report, not hide.
4. **Assert on what the unit produces**, not on what a mock was told to return. Mocks are for
   *isolating* the unit and for *interaction* checks (`toHaveBeenCalledWith`), not for producing the
   value you assert on. The same goes for literals the test built itself: `const p = { service: 's3' };
   expect(p.service).toBe('s3')` checks nothing. Types don't exist at runtime — check types with
   `expectTypeOf` / `tsd` / `// @ts-expect-error`, and check behavior by passing the literal *through* the unit.
5. **No assertion inside `try/catch`.** Use `expect(() => f()).toThrow(...)` /
   `await expect(p).rejects.toThrow(...)`.
6. **Every test asserts something specific.** "Does not throw", `toBeDefined()`, `toBeTruthy()` and a
   bare snapshot are almost never the real contract. Assert the exact value, field, or call.
7. **Never leave `.only` / `.skip` / `xit`** in committed code. Use `it.todo('...')` for planned tests.
8. **Coverage is not verification.** A line executed by a test is not a line checked by a test.

Detailed patterns and examples: [references/writing-honest-tests.md](references/writing-honest-tests.md).

## Mode 1 — Writing tests

Before writing each test, answer in one line: *"Which bug would make this test fail?"* If you can't
name one, don't write the test.

For each unit:

1. List its behaviors: normal results, **boundaries** (0, empty, max, `>=` vs `>`), error paths, and
   side effects (calls it must make).
2. Write one focused test per behavior with a hand-derived expected value. Name the test after the
   behavior (`'charges 5 below the free-shipping threshold'`), not the function (`'works'`).
3. Mock only boundaries. Prefer real collaborators when they are cheap and deterministic.
4. Self-audit when done (both commands are safe; neither modifies your files):

   ```bash
   npx @mintwork/honest-tests audit <test files or dir>
   npx @mintwork/honest-tests mutate <source file you just tested>
   ```

5. Fix every `error` finding. For each **surviving mutant**, either add the missing assertion (usually
   a boundary or an exact value) or explain why the mutant is equivalent. Report the final mutation
   score to the user.

## Mode 2 — Auditing tests (phased)

Run the phases in order. Do not skip Phase 2: unverified findings erode trust.

### Phase 1 — Detect

```bash
npx @mintwork/honest-tests audit <path> --json > honest-tests.json
```

The JSON contains `findings[]` with `ruleId`, `severity`, `file`, `line`, `column`, `test`, `message`,
`evidence`, `fix`, plus a `summary`. To audit only what a branch or PR changed, add
`--changed origin/main`; the report then says how many tests the change adds and how many of those can't fail. If the CLI cannot be installed, use the manual grep checklist in
[references/audit-procedure.md](references/audit-procedure.md#manual-fallback).

Also look for smells the detector does not catch yet (see the "beyond the detector" list in
[references/test-smells.md](references/test-smells.md)), e.g. expected values copied from output or
re-implemented formulas the narrow rules miss, or assertions on irrelevant details.

### Phase 2 — Verify each finding

For every finding, open the file at `line`, read the whole test, and classify it:

- **confirmed** — the test cannot fail for the bug its name implies.
- **false-positive** — the detector misread the code (explain why in one sentence).
- **accepted** — technically a smell but intentional and harmless (e.g. a deliberate smoke test).
  Suggest `// honest-tests-disable-next-line <rule-id>` with a reason.

Prove the important ones. The strongest proof is a mutation that survives:

```bash
npx @mintwork/honest-tests mutate <source file the test targets> --json
```

Surviving mutants are concrete, line-level evidence: "changing `>=` to `>` on line 22 does not fail any
test". Mutation runs on a temporary copy of the project; your working tree is never modified. See
[references/mutation-testing.md](references/mutation-testing.md) for reading results and equivalent
mutants.

Per-rule verification notes: [references/test-smells.md](references/test-smells.md).

### Phase 3 — Report

Lead with the headline number, then confirmed findings grouped by severity, then surviving mutants.
Use the template in [references/audit-procedure.md](references/audit-procedure.md#report-template).
When the user wants machine-readable output, return the verified findings as JSON with an added
`verdict` (`confirmed` | `false-positive` | `accepted`) and `note` per finding.

### Phase 4 — Fix (only when asked)

Rewrite confirmed findings into honest tests following Mode 1. Re-run `audit` and `mutate`, and show the
before/after mutation score. Never "fix" a finding by deleting the assertion or adding a disable comment
without the user's agreement.

## Rules detected by the CLI

| Rule | Severity | Catches |
| --- | --- | --- |
| `no-assertions` | error | Test body never asserts |
| `tautological-assertion` | error | `expect(x).toBe(x)`, `expect(true).toBe(true)`, expected derived from actual |
| `asserts-on-mock` | error | Asserting on the return value of a mock the test configured |
| `asserts-on-own-literal` | error | Asserting on a literal the test just built (`const p = { service: 's3' }; expect(p.service).toBe('s3')`) — typical of runtime "type tests" |
| `never-failing-assertion` | error | `expect(x).toBeTruthy` (no call), bare `expect(x)`, un-awaited `.resolves`, `typeof x` "defined", `length >= 0` |
| `swallowed-assertion` | error | Assertion inside `try` whose `catch` doesn't rethrow |
| `catch-only-assertion` | error (warning if it also asserts outside the `catch`) | Assertions only in `catch` — passes when nothing throws |
| `mocked-unit-under-test` | error (warning for partial mocks) | `vi.mock('./cart')` in `cart.test.ts`; spying on and replacing the unit's exports |
| `focused-test` | error | `.only`, `fit`, `fdescribe` |
| `excessive-mocking` | warning | 5+ module mocks in one file |
| `snapshot-only` | warning | The only assertion is a snapshot |
| `conditional-assertion` | warning | Assertion behind `if`/`&&`/ternary |
| `reimplemented-algorithm` | warning | Expected value recomputed from the call's own inputs: `expect(total(p, q)).toBe(p * q * 1.2)` |
| `oracle-copied-from-output` | warning | Expected float carries rounding noise (`2.9000000000000004`) — copied from the code's output |
| `skipped-test` | warning | `.skip`, `xit`, `xdescribe` |
| `weak-called-assertion` | info (warning if the test checks nothing else) | Bare `toHaveBeenCalled()` on a shared mock whose arguments other tests check |

The same rules run on pytest/unittest files (`assert`, `pytest.raises`, `self.assert*`, `patch`, `Mock`),
except `reimplemented-algorithm`, `oracle-copied-from-output` and `weak-called-assertion` (JS/TS only for
now; check those smells by hand in Python suites). The CLI needs `python3` 3.9+ for pytest files. Mutation testing is JS/TS only.
