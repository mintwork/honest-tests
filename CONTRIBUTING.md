# Contributing to honest-tests

Thanks for helping agents (and humans) write tests that can fail.

## Setup

```bash
npm install        # also builds dist/ via the prepare script
npm test           # vitest: rules, fixtures, CLI, and real mutation runs on fixtures/
npm run typecheck
npm run dogfood    # honest-tests must report zero findings on its own tests
npm run demo:gif   # re-render docs/demo.gif from the real CLI output (Playwright + Google Chrome + ffmpeg)
```

Node 22+. Runtime dependencies are deliberately minimal (`@babel/parser` only) — please don't add more
without discussion.

## Layout

```
src/core/types.ts        language-neutral TestFileModel, Rule, Finding, Mutant, LanguageAdapter
src/core/engine.ts       file discovery, rule execution, suppression comments
src/adapters/js/         JS/TS parser (babel) -> TestFileModel, mutant generator
src/adapters/python/     pytest adapter seam (planned)
src/rules/               one file per rule; rules only read the TestFileModel
src/mutate/runner.ts     temp-copy mutation runner (parallel workers)
src/mutate/coverage.ts   probes for the per-test-file coverage map
src/report/              human, JSON and SARIF output
src/action/              GitHub Action entry point + PR comment (action.yml at the repo root)
examples/                GitHub Action workflows
skills/honest-tests/     the Agent Skill (SKILL.md + references/)
commands/                Claude Code plugin slash commands
integrations/            Codex AGENTS.md snippet, Cursor rule
fixtures/                bad-project (fake tests), good-project (honest tests), mapped-project
                         (coverage map), node-test-project, python-project
```

## Adding a rule

1. Create `src/rules/<rule-id>.ts` exporting a `Rule` (`id`, `severity`, `description`, `fix`, `check`).
   Rules must work on the `TestFileModel` only — no parser imports — so every language adapter gets
   them for free. If you need a new fact, add it to the model and populate it in the adapter.
2. Register it in `src/rules/index.ts`.
3. Add positive **and negative** cases to `test/rules.test.ts`. Negative cases matter: run
   `node dist/cli.js mutate src/rules/<rule-id>.ts --test-cmd "vitest run test/rules.test.ts"` and
   kill the survivors (or explain why they're equivalent in the PR).
4. Document it in `skills/honest-tests/references/test-smells.md` (bad example, honest example, how to
   verify / known false positives), the rules table in `SKILL.md`, and `README.md`.
5. If it's an agent-typical smell, plant it in `fixtures/bad-project` and update `test/fixtures.test.ts`.

False positives are worse than misses: a rule that cries wolf trains agents to add disable comments.
When in doubt, make it a `warning`.

## Adding a language adapter

Implement `LanguageAdapter` (`src/core/types.ts`): `isTestFile`, `parseTestFile` → `TestFileModel`,
and optionally `generateMutants`, `testImportsTarget`, `defaultTestCommand`. Register it in
`src/adapters/index.ts`. See `src/adapters/python/index.ts` for the pytest mapping plan.

## Commits & PRs

- Small, focused PRs with tests. `npm test`, `npm run typecheck` and `npm run dogfood` must pass.
- Never weaken an existing test to make your change pass. (Yes, we check.)

## Releasing

1. Bump `version` in `package.json`, `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`,
   update `CHANGELOG.md`, add `docs/release-notes-vX.Y.Z.md`, commit and push.
2. Create the release; the [release workflow](.github/workflows/release.yml) checks that the tag
   matches `package.json`, runs the typecheck, tests and dogfood audit, and publishes to npm with
   provenance:

   ```bash
   gh release create v0.2.0 --title "honest-tests v0.2.0" --notes-file docs/release-notes-v0.2.0.md
   ```

**npm auth:** [trusted publishing](https://docs.npmjs.com/trusted-publishers) only; no npm token
is stored in the repository. npm accepts publishes of this package only from `release.yml` in
`mintwork/honest-tests` (set under the package's Settings → Trusted Publisher on npmjs.com). A version
already on npm is skipped, and manual runs of the workflow are dry runs.


## Publishing to Agensi

[Agensi](https://agensi.io) has no API or CI publishing, so every GitHub Release gets a
ready-to-upload package attached (`*-agensi.zip`, built by `npm run build:agensi`). The build adds
Agensi's listing fields (`version`, `summary`, `tags`, `docs_url`) to the packaged `SKILL.md` only
and checks Agensi's limits (100 files, 5 MB, text only). To publish or update the listing, either
upload the ZIP in Agensi's Creator Studio, or ask an agent connected to Agensi to `update_skill`
from it.
