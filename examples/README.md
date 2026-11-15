# Examples

## GitHub Action: "Honest Tests Audit"

[`action.yml`](../action.yml) audits the test files a pull request changes, writes the result to the
job summary and creates (then keeps updating) one PR comment:

> **This PR adds 12 tests — 4 can't fail.**
>
> | Severity | Change | Test | Finding | Location |
> | --- | --- | --- | --- | --- |
> | error | added | applies a discount | Assertion is inside a try/catch that swallows errors … `swallowed-assertion` | `test/pricing.test.ts:39` |

It parses test files only; it never installs your dependencies or runs your code or tests, so it is
safe on pull requests from forks. (Fork PRs get a read-only token, so the comment is skipped there with
a warning; the job summary still has the report.)

- [`github-action/honest-tests.yml`](github-action/honest-tests.yml): PR comment, fail when a new or
  changed test can't fail.
- [`github-action/code-scanning.yml`](github-action/code-scanning.yml): also upload SARIF to GitHub code
  scanning.
- [`github-action/monorepo.yml`](github-action/monorepo.yml): several packages in one audit.

Inputs: `base`, `paths`, `ignore`, `working-directory`, `fail-on` (`error` | `warning` | `never`;
only findings in tests the PR adds or modifies count), `comment`, `sarif-file`, `github-token`.
Outputs: `tests-added`, `tests-modified`, `cant-fail-added`, `cant-fail-modified`, `findings`, `report`
(JSON path), `sarif-file`.

`actions/checkout` needs `fetch-depth: 0` so the merge base is available; with a shallow checkout the
action fetches the missing history itself, which is slower.
