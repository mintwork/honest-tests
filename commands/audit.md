---
description: Audit tests for fake/weak tests (detect → verify → report) using the honest-tests skill
argument-hint: "[path] [--mutate <source-file>] [--changed <base-ref>]"
---

Use the `honest-tests` skill to audit the tests in: $ARGUMENTS (default: the whole repo).

Follow the skill's phased procedure exactly:

1. **Detect** — run `npx @mintwork/honest-tests audit <path> --json` (add `--mutate <file>` or `--changed <ref>` if given), plus the manual
   "beyond the detector" pass.
2. **Verify** — open every finding, classify it as confirmed / false-positive / accepted with a one-line note.
   Prove the important ones with surviving mutants (`npx @mintwork/honest-tests mutate <source-file>`).
3. **Report** — use the report template from `references/audit-procedure.md`, leading with
   "N of M tests can't fail" and the mutation score.

Do not modify any files unless I ask you to fix the findings.
