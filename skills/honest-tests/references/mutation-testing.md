# Mutation testing with honest-tests

Static rules find tests that *look* fake. Mutation testing proves whether tests *are* fake: it makes
small, deliberate bugs in the source and checks whether any test notices.

```bash
npx @mintwork/honest-tests mutate src/pricing.ts
npx @mintwork/honest-tests audit test/ --mutate src/pricing.ts --json   # both, one JSON document
```

## What it does

1. Finds the project root (nearest `package.json`) and the test files that import the target.
2. Copies the project to a temp directory (`node_modules` is symlinked, `.git` is skipped).
   **Your working tree is never written to.** The copy is deleted at the end, including on Ctrl-C.
3. Runs the tests once unmutated (baseline). If they fail, it stops — fix the suite first.
4. For each mutant: writes the mutated file into a copy, runs the tests, restores the file. Mutants
   run in parallel, one copy per worker (`--concurrency`, default half the cores, 1–4); if the
   baseline fails when the copies run at once, it falls back to one worker.
   With 2+ related test files, a coverage map first runs each test file against a probed copy of
   the target; each mutant then runs only the test files that execute its statement.
   - tests fail → **killed** (good)
   - tests pass → **survived** (the tests don't check this behavior)
   - tests hang past the timeout → **timeout** (counted as killed)
   - no related test executes it (`noCoverage: true`) → **survived** without a run: nothing tests
     that line at all
5. Reports the mutation score = (killed + timeout) / tested, and every survivor with its line.

Default test command: the package's `test` script, scoped to the related test files for vitest/jest
(`npm test --silent -- test/pricing.test.ts`). Override with `--test-cmd "pnpm vitest run {files}"`;
`{files}` expands to the related test files.

## Mutation operators

| Operator | Example | A surviving mutant usually means |
| --- | --- | --- |
| binary | `>=` → `>`, `<` → `<=`, `===` → `!==`, `+` → `-`, `*` → `/` | boundary or arithmetic not checked with an exact value |
| logical | `&&` → `\|\|` | only one side of the condition is ever exercised |
| assignment | `+=` → `-=` | accumulation not checked |
| boolean | `true` → `false` | the flag's effect is never asserted |
| negation | `!x` → `x` | the negative branch is untested |
| number | `50` → `51`, `0` → `1` | the constant's exact value (threshold, initial value) is unchecked |
| condition | `if (c)` → `if (true)` / `if (false)` | one branch of the `if` is untested |
| return | `return x` → `return undefined` | the return value is never asserted |

Types, imports, string concatenation and `console.*`/logger calls are never mutated.

## Reading survivors

```
pricing.ts:22  return isMember || total >= 50;
    ✗ `>=` → `>`
    ✗ `50` → `51`
```

Translate each survivor into the missing test:

- `>=` → `>` survived on `total >= 50` → add `expect(qualifiesForFreeShipping(50, false)).toBe(true)`.
- `return x` → `undefined` survived → some test calls the function but never checks the result.
- `if (c)` → `if (false)` survived → no test enters that branch with an observable effect.

## Equivalent mutants

Some mutants don't change behavior (e.g. `i < len` → `i <= len` where the extra iteration is a no-op, or
an `if` guard that only short-circuits an optimization). They can't be killed. When you judge a mutant
equivalent, say so explicitly with a one-line reason — don't write a contrived test for it.

## Practical tips

- Target one file at a time: the one you just wrote tests for, or the riskiest module in the audit.
- Cap long runs with `--max-mutants <n>`; use `--timeout <ms>` for slow suites.
- Check the `notes` in the report: they say when parallel runs or the coverage map were turned off
  and why. Use `--coverage-map off` if a test file only passes together with the others.
- Gate CI with `--min-score 80` (exit 1 below the threshold).
- A score of 100% does not mean the tests are perfect; it means every simple mutation was caught.
  A low score is very strong evidence that tests are fake.
