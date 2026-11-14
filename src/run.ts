import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { audit, selectRules, type AuditResult } from './core/engine.js';
import { changedFiles, GitError, type ChangedFiles } from './core/git.js';
import { mutate, MutationError, type MutationReport } from './mutate/runner.js';
import { c } from './report/colors.js';
import { formatAudit, formatMutation } from './report/human.js';
import { toJson } from './report/json.js';
import { toSarif } from './report/sarif.js';
import { rules } from './rules/index.js';

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function version(): string {
  try {
    return (JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

export interface IO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  cwd: string;
  /** Show mutation progress on stderr. */
  progress?: boolean;
}

const HELP = `honest-tests — find tests that can't fail.

Usage
  honest-tests audit [paths...]          Detect fake/weak tests (default: .)
  honest-tests audit [paths] --mutate <file>
                                         ...then mutation-check a source file
  honest-tests mutate <file>             Mutation check only
  honest-tests rules                     List rules
  honest-tests init <claude|codex|cursor> Install the agent skill/rules into this repo

Audit options
  --json                 Machine-readable output (findings with file/line/rule/severity/evidence)
  --sarif                SARIF 2.1.0 output for GitHub code scanning (run from the repo root)
  --changed <ref>        Only audit test files changed since the merge base with <ref> (e.g. origin/main),
                         including uncommitted and untracked files; reports which tests were added
  -v, --verbose          Show fix advice for each finding
  --ignore <glob>        Ignore paths (repeatable), e.g. --ignore "fixtures/**"
  --rule <id>            Only run these rules (repeatable)
  --disable <id>         Skip these rules (repeatable)
  --fail-on <level>      error (default) | warning | never

Mutation options
  --mutate <file>        Source file to mutate (with audit)
  --test-cmd <cmd>       Test command (default: package.json "test" script, scoped to related tests).
                         "{files}" is replaced with test files that import the target.
  --root <dir>           Project root (default: nearest package.json above the target)
  --max-mutants <n>      Cap on mutants to run (default 100)
  --timeout <ms>         Per-run timeout (default: 4x baseline + 5s)
  --min-score <0-100>    Exit 1 if mutation score is below this (default: 0, report only)

Suppress a finding:   // honest-tests-disable-next-line <rule-id>`;

export async function run(argv: string[], io: IO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        sarif: { type: 'boolean' },
        changed: { type: 'string' },
        verbose: { type: 'boolean', short: 'v' },
        ignore: { type: 'string', multiple: true },
        rule: { type: 'string', multiple: true },
        disable: { type: 'string', multiple: true },
        'fail-on': { type: 'string' },
        mutate: { type: 'string' },
        'test-cmd': { type: 'string' },
        root: { type: 'string' },
        'max-mutants': { type: 'string' },
        timeout: { type: 'string' },
        'min-score': { type: 'string' },
        dir: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
      },
    });
  } catch (e) {
    io.stderr(`${(e as Error).message}\n\n${HELP}\n`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  if (v.version) {
    io.stdout(version() + '\n');
    return 0;
  }
  const [command, ...rest] = positionals;
  if (v.help || !command) {
    io.stdout(HELP + '\n');
    return command || v.help ? 0 : 2;
  }

  if (command === 'rules') {
    if (v.json) io.stdout(JSON.stringify(rules.map(({ id, severity, description, fix }) => ({ id, severity, description, fix })), null, 2) + '\n');
    else for (const r of rules) io.stdout(`${c.bold(r.id.padEnd(26))} ${r.severity.padEnd(8)} ${r.description}\n`);
    return 0;
  }

  if (command === 'init') return init(rest[0], v.dir ?? io.cwd, io);

  if (command !== 'audit' && command !== 'mutate') {
    io.stderr(`Unknown command "${command}".\n\n${HELP}\n`);
    return 2;
  }

  const unknownRules = [...(v.rule ?? []), ...(v.disable ?? [])].filter((id) => !rules.some((r) => r.id === id));
  if (unknownRules.length) {
    io.stderr(`Unknown rule(s): ${unknownRules.join(', ')}. Run "honest-tests rules".\n`);
    return 2;
  }
  const failOn = v['fail-on'] ?? 'error';
  if (!['error', 'warning', 'never'].includes(failOn)) {
    io.stderr(`--fail-on must be error, warning or never.\n`);
    return 2;
  }

  if (v.json && v.sarif) {
    io.stderr('--json and --sarif are mutually exclusive.\n');
    return 2;
  }
  if (v.changed !== undefined && command !== 'audit') {
    io.stderr('--changed only applies to "honest-tests audit".\n');
    return 2;
  }
  const machine = v.json || v.sarif;

  let auditResult: AuditResult | null = null;
  let exit = 0;
  if (command === 'audit') {
    let changed: ChangedFiles | undefined;
    if (v.changed !== undefined) {
      try {
        changed = changedFiles(io.cwd, v.changed);
      } catch (e) {
        if (!(e instanceof GitError)) throw e;
        io.stderr(c.red(`--changed: ${e.message}\n`));
        return 2;
      }
    }
    auditResult = audit({ paths: rest, cwd: io.cwd, ignore: v.ignore, only: v.rule, disable: v.disable, changed }, version());
    const { error, warning } = auditResult.summary;
    if ((failOn === 'error' && error > 0) || (failOn === 'warning' && error + warning > 0)) exit = 1;
    if (!machine) io.stdout(formatAudit(auditResult, { verbose: v.verbose }) + '\n');
  }

  const target = command === 'mutate' ? rest[0] : v.mutate;
  if (command === 'mutate' && !target) {
    io.stderr('Usage: honest-tests mutate <source-file>\n');
    return 2;
  }
  let mutation: MutationReport | null = null;
  if (target) {
    const num = (s: string | undefined) => (s === undefined ? undefined : Number(s));
    const showProgress = !machine && io.progress;
    try {
      mutation = await mutate({
        target,
        cwd: io.cwd,
        root: v.root,
        testCmd: v['test-cmd'],
        maxMutants: num(v['max-mutants']),
        timeoutMs: num(v.timeout),
        onProgress: showProgress
          ? (done, total, r) => io.stderr(`\r  mutating ${target}: ${done}/${total} ${r.status === 'survived' ? c.red('survived') : c.green(r.status)}   `)
          : undefined,
      });
      if (showProgress) io.stderr('\r\x1b[2K');
    } catch (e) {
      if (showProgress) io.stderr('\n');
      const err = e as MutationError;
      io.stderr(c.red(`Mutation check failed: ${err.message}\n`));
      if (err.output) io.stderr(c.dim(excerpt(err.output)) + '\n');
      return 2;
    }
    if (!machine) io.stdout(formatMutation(mutation) + '\n');
    const minScore = num(v['min-score']) ?? 0;
    if (mutation.score < minScore) exit = 1;
  }

  if (v.json) io.stdout(toJson(auditResult, mutation) + '\n');
  if (v.sarif) io.stdout(toSarif(auditResult, mutation, selectRules({ only: v.rule, disable: v.disable }), version(), io.cwd) + '\n');
  return exit;
}

/** First and last lines of a test run: the error is usually at the top, the summary at the bottom. */
export function excerpt(output: string, headLines = 20, tailLines = 20): string {
  const lines = output.replace(/\n{3,}/g, '\n\n').trimEnd().split('\n');
  if (lines.length <= headLines + tailLines) return lines.join('\n');
  return [...lines.slice(0, headLines), `  … ${lines.length - headLines - tailLines} lines …`, ...lines.slice(-tailLines)].join('\n');
}

const MARK_START = '<!-- honest-tests:start -->';
const MARK_END = '<!-- honest-tests:end -->';

function init(target: string | undefined, dir: string, io: IO): number {
  const base = resolve(io.cwd, dir);
  switch (target) {
    case 'claude': {
      const dest = join(base, '.claude', 'skills', 'honest-tests');
      cpSync(join(PACKAGE_ROOT, 'skills', 'honest-tests'), dest, { recursive: true });
      io.stdout(`Installed skill → ${dest}\nClaude Code will pick it up automatically. Try: "audit my tests with honest-tests".\n`);
      return 0;
    }
    case 'codex': {
      const snippet = readFileSync(join(PACKAGE_ROOT, 'integrations', 'codex', 'AGENTS.md'), 'utf8').trim();
      const dest = join(base, 'AGENTS.md');
      const block = `${MARK_START}\n${snippet}\n${MARK_END}`;
      let content = existsSync(dest) ? readFileSync(dest, 'utf8') : '';
      const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`);
      content = re.test(content) ? content.replace(re, block) : (content ? content.trimEnd() + '\n\n' : '') + block + '\n';
      writeFileSync(dest, content);
      io.stdout(`Added honest-tests section → ${dest}\n`);
      return 0;
    }
    case 'cursor': {
      const destDir = join(base, '.cursor', 'rules');
      mkdirSync(destDir, { recursive: true });
      cpSync(join(PACKAGE_ROOT, 'integrations', 'cursor', 'honest-tests.mdc'), join(destDir, 'honest-tests.mdc'));
      io.stdout(`Installed rule → ${join(destDir, 'honest-tests.mdc')}\n`);
      return 0;
    }
    default:
      io.stderr('Usage: honest-tests init <claude|codex|cursor> [--dir <repo>]\n');
      return 2;
  }
}
