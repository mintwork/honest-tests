# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **`--sarif`**: SARIF 2.1.0 output for GitHub code scanning (`github/codeql-action/upload-sarif`).
  Findings become results linked to their rule; with `--mutate` or `mutate`, surviving mutants are
  reported as `surviving-mutant` warnings at the mutated line.
- **`audit --changed <ref>`**: audit only the test files changed since the merge base with `<ref>`
  (committed, uncommitted and untracked), and report how many tests the change adds or modifies and
  how many of those can't fail. JSON output gains a `changed` summary and a `change` field on findings.
- **GitHub Action "Honest Tests Audit"** (`action.yml`): audits the test files a pull request changes
  and creates or updates one PR comment ("This PR adds 12 tests — 4 can't fail."), writes the job
  summary, annotates findings, optionally writes SARIF, and fails on findings in added or modified
  tests (`fail-on`). Static only: it never runs the repository's code. Usage in `examples/`.
- Three new rules, tuned for precision on real projects (they miss cases rather than cry wolf):
  - `reimplemented-algorithm` (warning): the expected value is numeric arithmetic over the call's own
    inputs, e.g. `expect(total(p, q)).toBe(p * q * 1.2)`.
  - `oracle-copied-from-output` (warning): the expected value is a float with rounding noise, e.g.
    `2.9000000000000004`, so it was copied from the code's output.
  - `weak-called-assertion` (info, or warning when the test checks nothing else): a bare
    `toHaveBeenCalled()` on a shared mock whose arguments other tests in the file check.
- **Parallel mutant runs:** `mutate --concurrency <n>` tests mutants in parallel, each worker in its
  own project copy. The default is half the CPU cores (1–4). The baseline also runs in every copy at
  once first; if that fails, the run falls back to one worker, so tests that share ports or services
  can't produce false kills.
- **Per-test-file coverage map:** with 2+ related test files, each mutant runs only the test files
  that execute its statement, found by running each file once against a probed copy of the target.
  Mutants no test executes are reported as survived ("no test executes this line") without a run.
  `--coverage-map auto|on|off`; JSON reports `concurrency`, `coverageMap`, `notes` and, per mutant,
  `noCoverage` / `testFiles`.

## [0.1.2] - 2026-11-14

### Changed

- README badges consolidated into one row; the npm downloads badge is removed until npm reports
  download counts for the new package (it showed "package not found or too new").
- Published from CI with npm trusted publishing (OIDC); no npm token is stored.

## [0.1.1] - 2026-11-14

### Changed

- The npm package is now **`@mintwork/honest-tests`**; run it with `npx @mintwork/honest-tests`. The unscoped
  `honest-tests` package is deprecated and points here.
- The repository moved to [github.com/mintwork/honest-tests](https://github.com/mintwork/honest-tests); old URLs
  redirect.
- Skill, plugin and editor-integration instructions use the new package name.

## [0.1.0] - 2026-11-14

First public release.

### Added

- **`honest-tests audit`**: static detection of JS/TS tests (vitest, jest, node:assert, chai) that
  can't fail. It has 13 rules:
  - errors: `no-assertions`, `tautological-assertion`, `asserts-on-mock`, `asserts-on-own-literal`,
    `never-failing-assertion`, `swallowed-assertion`, `catch-only-assertion`,
    `mocked-unit-under-test`, `focused-test`
  - warnings: `excessive-mocking`, `snapshot-only`, `conditional-assertion`, `skipped-test`
- **`asserts-on-own-literal`**: flags assertions on a literal the test just built, e.g.
  `const p = { service: 's3' }; expect(p.service).toBe('s3')`. These are common in runtime "type
  tests". The rule only fires when the value traces back purely to literals declared in the same
  test, and that binding is never passed to code, mutated or reassigned.
- **`honest-tests mutate <file>`**: built-in mutation testing. It works on a temporary copy of the
  project and only runs the test files that reach the target, so the working tree is never touched,
  even on Ctrl-C. Supports `--test-cmd`, `--max-mutants`, `--timeout` and `--min-score`.
  `audit --mutate <file>` combines both checks in one run.
- Output for humans and machines (`--json`, schema version 1), plus suppression comments
  (`honest-tests-disable-next-line`, `-disable-line` and file-level `disable`) and `--fail-on`.
- **Agent integrations**:
  - Agent Skill (`skills/honest-tests`) with a smell catalog, a guide to writing honest tests, an
    audit procedure and a mutation-testing reference.
  - Claude Code plugin and marketplace, with `/honest-tests:audit` and `/honest-tests:mutate`.
  - `honest-tests init claude|codex|cursor` installs the skill, an `AGENTS.md` section or a Cursor
    rule.
- `npm run demo:gif` renders the README demo from the real CLI output.

### Known limitations

- JS/TS only. The pytest adapter is planned; Python test files are reported as unsupported rather
  than skipped silently.
- `mutate` doesn't follow path-alias imports (`@/lib/x`) when picking related tests yet. Pass
  `--test-cmd` in that case.
- Mutants run one at a time.

[0.1.2]: https://github.com/mintwork/honest-tests/releases/tag/v0.1.2
[0.1.1]: https://github.com/mintwork/honest-tests/releases/tag/v0.1.1
[0.1.0]: https://github.com/mintwork/honest-tests/releases/tag/v0.1.0
