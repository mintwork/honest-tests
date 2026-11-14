# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Mocha, node:test, Bun and Deno** test files are audited, and `mutate` runs their related tests:
  - node:test: `t.test` subtests, `t.assert.*`, `{ skip, todo, only }` options, `t.skip()` / `t.todo()`,
    `t.plan(n)`, `mock.fn` / `t.mock.method` / `mock.module`, and tap/tspl-style `t.equal(...)`.
  - Mocha: `this.skip()`, `done` callbacks that the code calls back, files under `test/`.
  - Bun: `mock()` / `spyOn()` / `mock.module` from `bun:test`, `test.if` / `test.todoIf`.
  - Deno: every `Deno.test` call shape, `t.step`, `@std/assert` (jsr:, npm: and deno.land URLs),
    `assertSnapshot`; projects with only a `deno.json(c)` are found as mutation roots.
  - `mutate` passes the related test files to `mocha`, `node --test`, `bun test` and `deno test`, and drops
    `nyc` / `c8` wrappers so coverage thresholds don't fail subset runs.
- Files under `test/` and `test-*.js` files (node:test and mocha defaults) are audited when they contain
  tests; helpers and fixtures next to them are skipped.

### Fixed

- Fewer false positives: `assert.strictEqual('hello', await body.text())` (expected value first) is no
  longer read as an assertion on a constant; `assert.ok(0)` / `assert(false)` count as `fail()`; a catch
  that forwards the error (`reject(err)`, `done(err)`) or asserts on its details (`err.code`,
  `instanceof`) is not "swallowing"; constant checkpoints (`t.ok(true)`) under a planned assertion count
  aren't tautological.
- `it.each(table)(...)` / `test.skipIf(c)(...)` no longer count as two tests.

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
