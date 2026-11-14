# Audit procedure (detailed)

## Phase 0 — Scope

- Identify the test runner (`package.json` scripts, `vitest.config.*`, `jest.config.*`) and the test
  directories. Confirm the suite passes as-is: `npm test`. Mutation results are meaningless on a red
  suite.
- Agree on scope with the user if the repo is large: a package, a directory, or the files touched by a
  PR (`git diff --name-only main... | grep -E '\.(test|spec)\.'`).

## Phase 1 — Detect

```bash
npx @mintwork/honest-tests audit <paths...> --json > honest-tests.json
# useful flags
#   --ignore "fixtures/**"     skip paths (repeatable)
#   --rule <id> / --disable <id>
#   --fail-on warning|never     exit code policy (default: error)
```

Output shape (`schemaVersion: 1`):

```jsonc
{
  "schemaVersion": 1,
  "tool": "honest-tests",
  "version": "0.1.0",
  "filesScanned": 3,
  "testsScanned": 14,
  "summary": { "error": 12, "warning": 3, "info": 0, "suspiciousTests": 10 },
  "findings": [
    {
      "ruleId": "swallowed-assertion",
      "severity": "error",
      "file": "test/pricing.test.ts",
      "line": 39,
      "column": 7,
      "test": "computes the discounted price",
      "message": "Assertion is inside a try/catch that swallows errors ...",
      "evidence": "expect(applyDiscount(100, 20)).toBe(70);",
      "fix": "Remove the try/catch. For expected errors use ..."
    }
  ],
  "unsupported": [],   // test files that couldn't be analyzed, with a `reason` (e.g. no python3 for pytest files)
  "parseErrors": [],
  "mutation": { ... }  // present when --mutate was used
}
```

Then do a manual pass for the "beyond the detector" smells in `test-smells.md`.

## Phase 2 — Verify

For each finding:

1. Open `file` at `line`; read the entire test and any helpers it calls.
2. Check the per-rule "Verify" notes in `test-smells.md`.
3. Assign a verdict: `confirmed`, `false-positive`, or `accepted`, with a one-sentence note.
4. For high-impact findings, **prove** them:
   - Run `npx @mintwork/honest-tests mutate <source-file>`; cite a surviving mutant on the relevant line.
   - Or reason concretely: "If `applyDiscount` returned `amount` unchanged, this test would still pass
     because the `catch` swallows the AssertionError."

Never modify the user's source to prove a point; `mutate` works on a temp copy.

Group duplicates: the same smell repeated across 30 tests is one finding with 30 locations.

## Phase 3 — Report

### Report template

```markdown
## Test honesty audit — <scope>

**<N> of <M> tests can't fail** (or don't test what they claim). Mutation score for
<file>: **<S>%** (<survived> of <tested> mutants survived).

### Confirmed — errors
| Test | Rule | Why it can't fail | Fix |
| --- | --- | --- | --- |
| `pricing.test.ts:39` "computes the discounted price" | swallowed-assertion | catch eats the AssertionError; the asserted value (70) is actually wrong | drop try/catch, expect 80 |

### Confirmed — warnings
...

### Surviving mutants (untested behavior)
- `pricing.ts:22` `>=` → `>` — no test checks the exact free-shipping threshold (50).
- `pricing.ts:15` `100` → `101` — no test passes 101%.

### False positives / accepted
- `x.test.ts:12` no-assertions — smoke test for module import; accepted, added disable comment.

### Recommended next steps
1. ...
```

Machine-readable variant: the `findings` array from Phase 1 with two extra fields per finding:
`"verdict": "confirmed" | "false-positive" | "accepted"` and `"note": "<one sentence>"`.

## Phase 4 — Fix (only if asked)

- Rewrite confirmed findings following `writing-honest-tests.md`.
- Re-run `audit` (expect zero errors) and `mutate` (show before → after score).
- If a fixed test now fails, you may have found a real bug — stop and report it rather than adjusting
  the expectation.

## Manual fallback

Use this when the CLI cannot be installed.

```bash
# focused / skipped
grep -rnE '\b(it|test|describe)\.(only|skip)\b|\b(fit|fdescribe|xit|xdescribe|xtest)\(' --include='*.test.*' --include='*.spec.*' .
# constant / self comparisons
grep -rnE 'expect\((true|false|[0-9]+|null|undefined)\)\.' --include='*.test.*' .
grep -rnE 'expect\(([A-Za-z_.]+)\)\.(toBe|toEqual|toStrictEqual)\(\1\)' --include='*.test.*' .
# matcher never called
grep -rnE 'expect\(.*\)\.(not\.)?to[A-Za-z]+;\s*$' --include='*.test.*' .
# try/catch in tests
grep -rn -A3 'try {' --include='*.test.*' . | grep -n 'expect('
# mocked unit: for each foo.test.ts, look for vi.mock/jest.mock of a path ending in /foo
grep -rnE '(vi|jest)\.mock\(' --include='*.test.*' .
# snapshot-only
grep -rn 'toMatchSnapshot\|toMatchInlineSnapshot' --include='*.test.*' .
```

Then read each hit and apply Phase 2. For mutation without the CLI, change one operator in the source
on a scratch copy, run the tests, and restore; repeat for the most important comparisons.
