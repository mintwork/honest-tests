import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { adapterFor } from '../adapters/index.js';
import { resolveTestScript, scopedTestCommand } from '../adapters/js/index.js';
import { DEFAULT_IGNORED_DIRS, discoverTestFiles } from '../core/engine.js';
import type { LanguageAdapter, Mutant } from '../core/types.js';

export type MutantStatus = 'killed' | 'survived' | 'timeout';

export interface MutantResult extends Mutant {
  status: MutantStatus;
  /** Original source line, trimmed. */
  sourceLine: string;
  durationMs: number;
}

export interface MutateOptions {
  /** Source file to mutate. */
  target: string;
  cwd?: string;
  /** Project root (dir with package.json). Defaults to nearest ancestor of target. */
  root?: string;
  /** Test command. `{files}` is replaced with the related test files. Defaults to the package's `test` script. */
  testCmd?: string;
  /** Stop after this many mutants (default 100). */
  maxMutants?: number;
  /** Per-run timeout; default derived from the baseline run. */
  timeoutMs?: number;
  onProgress?: (done: number, total: number, result: MutantResult) => void;
}

export interface MutationReport {
  target: string;
  root: string;
  command: string;
  relatedTests: string[];
  baselineMs: number;
  generated: number;
  tested: number;
  killed: number;
  survived: number;
  timedOut: number;
  /** 0-100, (killed + timeout) / tested. */
  score: number;
  mutants: MutantResult[];
}

export class MutationError extends Error {
  constructor(
    message: string,
    public output = '',
  ) {
    super(message);
  }
}

/** Nearest node_modules that holds installed packages (not just a `.vite` cache dir). */
function findNodeModules(start: string): string | null {
  let dir = start;
  for (;;) {
    const candidate = join(dir, 'node_modules');
    if (existsSync(candidate)) {
      const entries = readdirSync(candidate).filter((e) => e !== '.vite' && e !== '.cache' && e !== '.vite-temp');
      if (entries.length > 0) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Every `node_modules/.bin` from `start` upward, so `vitest`/`jest` resolve like they do under npm. */
function binPaths(start: string): string[] {
  const out: string[] = [];
  let dir = start;
  for (;;) {
    const bin = join(dir, 'node_modules', '.bin');
    if (existsSync(bin)) out.push(bin);
    const parent = dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
}

function sourceFiles(dir: string, exts: string[], out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!DEFAULT_IGNORED_DIRS.has(e.name)) sourceFiles(p, exts, out);
    } else if (e.isFile() && exts.includes(extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

/** A test file by name, or a `test/foo.js`-style candidate that contains tests (mocha, node:test). */
function isTestSource(adapter: LanguageAdapter, file: string, src: string): boolean {
  if (adapter.isTestFile(toPosix(file))) return true;
  if (!adapter.isCandidateTestFile?.(toPosix(file))) return false;
  try {
    return adapter.parseTestFile(file, src).tests.length > 0;
  } catch {
    return false;
  }
}

/** Files that mark a project root: package.json, or deno.json(c) for Deno projects without one. */
const ROOT_MARKERS = ['package.json', 'deno.json', 'deno.jsonc'];

function isProjectRoot(dir: string): boolean {
  return ROOT_MARKERS.some((m) => existsSync(join(dir, m)));
}

function findProjectRoot(start: string): string | null {
  for (let dir = start; ; dir = dirname(dir)) {
    if (isProjectRoot(dir)) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Test files that import `target` directly or through other local modules
 * (`test -> Page.jsx -> lib/format.js`). Direct-import-only selection misses
 * tests that exercise the target through its callers, which shows up as
 * false survivors.
 */
export function findRelatedTests(root: string, target: string, adapter: LanguageAdapter): string[] {
  if (!adapter.localImports || !adapter.moduleId) {
    return discoverTestFiles([root], root).filter((f) => adapter.testImportsTarget?.(f, readFileSync(f, 'utf8'), target));
  }
  const importers = new Map<string, string[]>();
  const testFiles = new Set<string>();
  for (const file of sourceFiles(root, adapter.extensions)) {
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const id of new Set(adapter.localImports(file, src))) importers.set(id, [...(importers.get(id) ?? []), file]);
    if (isTestSource(adapter, file, src)) testFiles.add(file);
  }
  const tests = new Set<string>();
  const seen = new Set<string>([adapter.moduleId(target)]);
  const queue = [...seen];
  while (queue.length) {
    for (const file of importers.get(queue.shift()!) ?? []) {
      if (testFiles.has(file)) {
        tests.add(file);
        continue;
      }
      const id = adapter.moduleId(file);
      if (!seen.has(id)) {
        seen.add(id);
        queue.push(id);
      }
    }
  }
  return [...tests].sort();
}

/** Nearest ancestor (or `root` itself) that is a pnpm/yarn/npm workspace root. */
function workspaceRootOf(root: string): string | null {
  let dir = root;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { workspaces?: unknown };
      if (pkg.workspaces) return dir;
    } catch {
      /* no package.json here */
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const linkType = process.platform === 'win32' ? 'junction' : 'dir';

function copyProject(from: string, to: string) {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src);
      return !rel.split(sep).includes('node_modules') && rel.split(sep)[0] !== '.git';
    },
  });
}

/** Every node_modules directory under `dir` (not descending into them). */
function nodeModulesDirs(dir: string, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.name === 'node_modules') out.push(p);
    else nodeModulesDirs(p, out);
  }
  return out;
}

/**
 * Copy the project into `tmp` and return the directory to run tests in.
 *
 * Plain packages: `tmp/` is the copy and `tmp/node_modules` links to the nearest installed node_modules.
 * Workspace packages (`pkgs/core` in a pnpm/yarn/npm monorepo): the whole workspace is copied (without
 * node_modules and .git) so root configs, tsconfig project references and sibling packages resolve,
 * and every node_modules directory is linked back at the same relative spot.
 */
function prepareCopy(root: string, tmp: string): string {
  const ws = workspaceRootOf(root);
  if (!ws || ws === root) {
    copyProject(root, tmp);
    const nm = findNodeModules(root);
    if (nm) symlinkSync(nm, join(tmp, 'node_modules'), linkType);
    return tmp;
  }
  copyProject(ws, tmp);
  for (const nm of nodeModulesDirs(ws)) {
    const dest = join(tmp, relative(ws, nm));
    if (existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    symlinkSync(nm, dest, linkType);
  }
  return join(tmp, relative(ws, root));
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function cleanEnv(extraPath: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Don't leak an outer vitest/jest worker context into the child run.
    if (/^(VITEST|JEST_WORKER_ID|TINYPOOL|__VITEST)/.test(k)) continue;
    env[k] = v;
  }
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [...extraPath, env[pathKey] ?? ''].join(delimiter);
  env.FORCE_COLOR = '0';
  env.NO_COLOR = '1';
  return env;
}

interface RunOutcome {
  code: number | null;
  timedOut: boolean;
  output: string;
  durationMs: number;
}

/** Test runs in flight. They run in their own process group, so Ctrl-C doesn't reach them by itself. */
const running = new Set<ChildProcess>();

function killTree(child: ChildProcess) {
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Kill every in-flight test run (and its children). Used on Ctrl-C/SIGTERM before removing the copy. */
export function killRunningTests() {
  for (const child of running) killTree(child);
}

function runCommand(command: string, cwd: string, timeoutMs: number, extraPath: string[]): Promise<RunOutcome> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      env: cleanEnv(extraPath),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.add(child);
    child.on('exit', () => running.delete(child));
    // Keep the start (where runners print the actual error) and the end (the summary).
    let head = '';
    let tail = '';
    let dropped = false;
    const collect = (d: Buffer) => {
      const text = d.toString();
      if (head.length < 6_000) {
        const room = 6_000 - head.length;
        head += text.slice(0, room);
        tail += text.slice(room);
      } else tail += text;
      if (tail.length > 16_000) {
        tail = tail.slice(-16_000);
        dropped = true;
      }
    };
    const output = () => (dropped ? `${head}\n…\n${tail}` : head + tail);
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    let timedOut = false;
    const kill = () => killTree(child);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, timedOut, output: output(), durationMs: Date.now() - started });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ code: 1, timedOut, output: output() + String(err), durationMs: Date.now() - started });
    });
  });
}

function shellQuote(s: string): string {
  return /^[\w./@:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Mutation-test one source file.
 *
 * Safety: the project is copied to a fresh temp directory (node_modules is
 * symlinked, never copied or written by us). Mutants are written only inside
 * the copy, restored after every run, and the copy is deleted at the end —
 * including on Ctrl-C. Your working tree is never modified.
 */
export async function mutate(opts: MutateOptions): Promise<MutationReport> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const target = resolve(cwd, opts.target);
  if (!existsSync(target)) throw new MutationError(`Target file not found: ${opts.target}`);
  const adapter = adapterFor(target);
  if (!adapter?.generateMutants) throw new MutationError(`Mutation is not supported for ${opts.target} yet.`);

  const root = opts.root ? resolve(cwd, opts.root) : findProjectRoot(dirname(target));
  if (!root || !isProjectRoot(root)) throw new MutationError(`Could not find a package.json (or deno.json) above ${opts.target}; pass --root.`);
  const relTarget = relative(root, target);
  if (relTarget.startsWith('..')) throw new MutationError(`Target ${opts.target} is outside project root ${root}.`);

  // Which tests exercise this file?
  const relatedTests = findRelatedTests(root, target, adapter).map((f) => toPosix(relative(root, f)));

  let command = opts.testCmd ?? null;
  if (command) {
    command = command.replace('{files}', relatedTests.map(shellQuote).join(' '));
  } else {
    command = adapter.defaultTestCommand?.(root) ?? null;
    if (!command) throw new MutationError('Could not determine how to run tests (no "test" script in package.json or deno.json). Pass --test-cmd "<command>".');
    command = scopedTestCommand(resolveTestScript(root), relatedTests.map(shellQuote)) ?? command;
  }

  const source = readFileSync(target, 'utf8');
  const all = adapter.generateMutants(target, source);
  const mutants = all.slice(0, opts.maxMutants ?? 100);
  const sourceLines = source.split(/\r?\n/);

  const tmp = mkdtempSync(join(tmpdir(), 'honest-tests-'));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  const onSignal = (sig: NodeJS.Signals) => {
    killRunningTests();
    cleanup();
    process.kill(process.pid, sig);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const work = prepareCopy(root, tmp);
    const tmpTarget = join(work, relTarget);
    // Real bin dirs, not the symlinked copy: pnpm's .bin shims resolve paths relative to their own
    // location, and from inside the temp dir `../../node_modules/.pnpm` points nowhere.
    const extraPath = binPaths(root);

    const baseline = await runCommand(command, work, opts.timeoutMs ?? 5 * 60_000, extraPath);
    if (baseline.code !== 0) {
      throw new MutationError(
        baseline.timedOut
          ? `Test command timed out before any mutation (${command}). If it starts a watcher or needs services, pass --test-cmd "<command that runs once>".`
          : `Tests fail before any mutation (exit ${baseline.code}). Fix them first — mutation results would be meaningless.`,
        baseline.output,
      );
    }
    const timeoutMs = opts.timeoutMs ?? Math.max(10_000, baseline.durationMs * 4 + 5_000);

    const results: MutantResult[] = [];
    for (const m of mutants) {
      let outcome: RunOutcome;
      try {
        writeFileSync(tmpTarget, source.slice(0, m.start) + m.replacement + source.slice(m.end));
        outcome = await runCommand(command, work, timeoutMs, extraPath);
      } finally {
        writeFileSync(tmpTarget, source);
      }
      const status: MutantStatus = outcome.timedOut ? 'timeout' : outcome.code === 0 ? 'survived' : 'killed';
      const r: MutantResult = { ...m, file: toPosix(relative(cwd, target)), status, sourceLine: (sourceLines[m.line - 1] ?? '').trim(), durationMs: outcome.durationMs };
      results.push(r);
      opts.onProgress?.(results.length, mutants.length, r);
    }

    const killed = results.filter((r) => r.status === 'killed').length;
    const timedOut = results.filter((r) => r.status === 'timeout').length;
    const survived = results.filter((r) => r.status === 'survived').length;
    return {
      target: toPosix(relative(cwd, target)),
      root: toPosix(relative(cwd, root)) || '.',
      command,
      relatedTests,
      baselineMs: baseline.durationMs,
      generated: all.length,
      tested: results.length,
      killed,
      survived,
      timedOut,
      score: results.length ? Math.round(((killed + timedOut) / results.length) * 1000) / 10 : 100,
      mutants: results,
    };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    cleanup();
  }
}
