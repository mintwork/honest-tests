import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { LanguageAdapter } from '../../core/types.js';
import { generateJsMutants } from './mutants.js';
import { parseJsTestFile } from './parse-tests.js';

const EXT = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'];
const TEST_FILE = /(\.|_|-)(test|spec)\.(m|c)?[jt]sx?$/i;
/** Co-located `foo/test.ts` / `foo/spec.js` (date-fns style). */
const BARE_TEST_FILE = /(^|\/)(test|spec)\.(m|c)?[jt]sx?$/i;

function stripExt(p: string): string {
  return p.replace(/\.(m|c)?[jt]sx?$/, '').replace(/\/index$/, '');
}

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|mock\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

/** Relative imports of a JS/TS file, as extension-less absolute module ids. */
function localImports(path: string, source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1]!;
    if (spec.startsWith('.')) out.push(stripExt(resolve(dirname(path), spec)));
  }
  return out;
}

/**
 * Files that are tests only if they turn out to contain test calls: node:test's `test-*.js` and
 * `test/**` defaults, mocha's `./test/*.js`. Helpers and fixtures next to them are skipped.
 */
const CANDIDATE_PREFIX = /(^|\/)test-[^/]*\.(m|c)?[jt]sx?$/i;
const CANDIDATE_DIR = /(^|\/)tests?\/(.+\/)?[^/]+\.(m|c)?[jt]sx?$/i;
const NOT_TESTS_DIR = /(^|\/)tests?\/(.+\/)?(fixtures?|__fixtures__|helpers?|support|utils?|mocks?|__mocks__|snapshots?|__snapshots__|data|assets|types)\//i;

function isTestFile(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  return TEST_FILE.test(p) || BARE_TEST_FILE.test(p) || (/\/__tests__\//.test(p) && /\.(m|c)?[jt]sx?$/.test(p));
}

function isCandidateTestFile(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  if (isTestFile(p) || /\.d\.(m|c)?ts$/.test(p)) return false;
  return CANDIDATE_PREFIX.test(p) || (CANDIDATE_DIR.test(p) && !NOT_TESTS_DIR.test(p));
}

export const jsAdapter: LanguageAdapter = {
  id: 'js',
  extensions: EXT,
  isTestFile,
  isCandidateTestFile,
  parseTestFile: parseJsTestFile,
  generateMutants: generateJsMutants,
  testImportsTarget(testPath, testSource, targetPath) {
    return localImports(testPath, testSource).includes(stripExt(resolve(targetPath)));
  },
  localImports,
  moduleId: (path) => stripExt(resolve(path)),
  defaultTestCommand(root) {
    const ts = resolveTestScript(root);
    if (ts.source === 'package.json') return 'npm test --silent';
    if (ts.source === 'deno.json') return ts.task ? 'deno task test' : 'deno test';
    return null;
  },
};

export type Runner = 'vitest' | 'jest' | 'mocha' | 'node' | 'bun' | 'deno' | 'unknown';

export interface TestScript {
  runner: Runner;
  /** The script that actually runs tests, after following `npm run x` / `pnpm x` delegation. */
  script: string;
  /** The script is one plain command (no `&&`, `;`, pipes) we can run directly with extra arguments. */
  simple: boolean;
  /** `test` only delegates to another script (`npm run test:unit`). */
  delegated: boolean;
  /** Coverage is switched on (`--coverage` in the script, or `enabled: true` in the runner config). */
  coverage: boolean;
  /** Where the test command comes from: a package.json script, a deno.json(c) task (or plain `deno test`), or nowhere. */
  source: 'package.json' | 'deno.json' | 'none';
  /** deno.json has a `test` task. */
  task?: boolean;
  /** The runner with an `nyc` / `c8` coverage wrapper removed, when the script had one. */
  unwrapped?: string;
}

const RUNNER_CONFIGS = [
  'vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs',
  'vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs',
  'jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs',
];

function coverageEnabledInConfig(root: string): boolean {
  for (const name of RUNNER_CONFIGS) {
    try {
      const text = readFileSync(join(root, name), 'utf8');
      if (/coverage\s*:\s*\{[^}]*enabled\s*:\s*true|collectCoverage\s*:\s*true/.test(text)) return true;
    } catch {
      /* not there */
    }
  }
  return false;
}

/** JSON with comments (deno.jsonc): drop `//` and block comments outside strings, then parse. */
export function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** deno.json(c) tasks as plain command strings (Deno 2 also allows `{ "command": "..." }`). */
function denoTasks(root: string): Record<string, string> | null {
  for (const name of ['deno.json', 'deno.jsonc']) {
    let text: string;
    try {
      text = readFileSync(join(root, name), 'utf8');
    } catch {
      continue;
    }
    try {
      const tasks = (parseJsonc(text) as { tasks?: Record<string, string | { command?: string }> }).tasks ?? {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(tasks)) {
        const cmd = typeof v === 'string' ? v : v?.command;
        if (typeof cmd === 'string') out[k] = cmd;
      }
      return out;
    } catch {
      return {};
    }
  }
  return null;
}

function runnerOf(script: string): Runner {
  if (/\bvitest\b/.test(script)) return 'vitest';
  if (/\bjest\b/.test(script)) return 'jest';
  if (/\b_?mocha\b/.test(script)) return 'mocha';
  if (/\bbun\s+test\b/.test(script)) return 'bun';
  if (/\bdeno\s+test\b/.test(script)) return 'deno';
  if (/\b(node|tsx)\b[^&|;]*?\s--test(?=\s|$)/.test(script)) return 'node';
  return 'unknown';
}

/** `nyc --reporter=lcov mocha` -> `mocha`: coverage wrappers (and their thresholds) don't belong in mutant runs. */
function stripCoverageWrapper(script: string): string | undefined {
  const words = script.trim().split(/\s+/);
  if (words[0] !== 'nyc' && words[0] !== 'c8') return undefined;
  const at = words.findIndex((w) => /^(_?mocha|node|tsx)$/.test(w));
  return at > 0 ? words.slice(at).join(' ') : undefined;
}

/** Follow `"test": "npm run test:unit"` chains to the script that runs the test runner. */
export function resolveTestScript(root: string): TestScript {
  let scripts: Record<string, string> | null = null;
  let source: TestScript['source'] = 'none';
  try {
    scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
    source = 'package.json';
  } catch {
    /* no package.json */
  }
  const tasks = denoTasks(root);
  if (tasks && (!scripts || scripts.test === undefined || /no test specified/.test(scripts.test))) {
    scripts = tasks;
    source = 'deno.json';
  }
  scripts ??= {};
  const task = source === 'deno.json' && scripts.test !== undefined;
  // A deno.json without a test task still has a known command: `deno test` discovers *_test.ts itself.
  let script = scripts.test ?? (source === 'deno.json' ? 'deno test' : '');
  if (source === 'package.json' && (!script || /no test specified/.test(script))) source = 'none';
  let delegated = false;
  for (let hops = 0; hops < 5; hops++) {
    const m = /^\s*(?:npm run|npm run-script|pnpm(?: run)?|yarn(?: run)?|bun run|deno task)\s+([\w:.-]+)\s*$/.exec(script);
    if (!m || scripts[m[1]!] === undefined) break;
    script = scripts[m[1]!]!;
    delegated = true;
  }
  const runner = runnerOf(script);
  const unwrapped = stripCoverageWrapper(script);
  return {
    runner,
    script: script.trim(),
    simple: !/&&|\|\||;|\||`|\$\(/.test(script),
    delegated,
    coverage: /--coverage\b(?!=false|\.enabled=false)/.test(script) || coverageEnabledInConfig(root),
    source,
    ...(task ? { task } : {}),
    ...(unwrapped ? { unwrapped } : {}),
  };
}

/** Which runner a package.json test script uses — lets us pass test files through. */
export function detectRunner(root: string): Runner {
  return resolveTestScript(root).runner;
}

/**
 * How to run `files` (already shell-quoted) once, never in watch mode:
 * - `test` runs vitest/jest/mocha/node --test itself: `npm test --silent -- [--run] <files>` (keeps npm pre/post hooks).
 * - `test` delegates (`npm run test:vitest`): run the plain leaf script directly, since npm would
 *   swallow `--run` as one of its own flags.
 * - bun and deno: run the plain script directly (`bun test ./a.test.ts`, `deno test -A a_test.ts`), no npm needed.
 * - an `nyc` / `c8` wrapper is dropped and the runner is run directly.
 * Returns null when we can't safely add arguments (unknown runner, `a && b` chains).
 */
export function scopedTestCommand(ts: TestScript, files: string[]): string | null {
  if (ts.runner === 'unknown') return null;
  if (ts.runner === 'bun' || ts.runner === 'deno' || ts.unwrapped) {
    if (!ts.simple) return null;
    // `bun test a.test.ts` treats the argument as a name filter; `./a.test.ts` is a path.
    const args = ts.runner === 'bun' ? files.map((f) => (/^'?(\.{0,2}\/)/.test(f) ? f : f.startsWith("'") ? `'./${f.slice(1)}` : `./${f}`)) : files;
    return [ts.unwrapped ?? ts.script, ...args].join(' ');
  }
  // A bare `vitest` script starts a watcher; mutation runs must exit.
  const needsRun = ts.runner === 'vitest' && !/\bvitest\s+(run|bench)\b|--run\b|--watch=false|--no-watch\b/.test(ts.script);
  // Coverage only slows mutant runs down, and global thresholds fail when we run a subset of tests.
  const noCoverage = ts.coverage && (ts.runner === 'vitest' || ts.runner === 'jest') ? [ts.runner === 'vitest' ? '--coverage.enabled=false' : '--coverage=false'] : [];
  const extra = [...(needsRun ? ['--run'] : []), ...noCoverage, ...files];
  if (!ts.delegated) return extra.length ? `npm test --silent -- ${extra.join(' ')}` : 'npm test --silent';
  if (!ts.simple) return null;
  return [ts.script, ...extra].join(' ');
}
