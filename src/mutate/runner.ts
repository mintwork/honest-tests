import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, type Dirent } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { delimiter, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { adapterFor } from '../adapters/index.js';
import { resolveTestScript, scopedTestCommand } from '../adapters/js/index.js';
import { DEFAULT_IGNORED_DIRS, discoverTestFiles } from '../core/engine.js';
import type { LanguageAdapter, Mutant } from '../core/types.js';
import { COVERAGE_ENV, instrument, LOADED_PROBE, parseHits, probeFor, type Instrumented } from './coverage.js';

export type MutantStatus = 'killed' | 'survived' | 'timeout';

export interface MutantResult extends Mutant {
  status: MutantStatus;
  /** Original source line, trimmed. */
  sourceLine: string;
  durationMs: number;
  /** No related test file executes the mutated code (per the coverage map), so it survived without a run. */
  noCoverage?: boolean;
  /** The test files run for this mutant, when the coverage map narrowed them down. */
  testFiles?: string[];
}

export type CoverageMapMode = 'auto' | 'on' | 'off';

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
  /** Mutants tested at once, each in its own copy of the project. Default: {@link defaultConcurrency}. */
  concurrency?: number;
  /**
   * Per-test-file coverage map: run each mutant only against the related test files that execute its
   * line. `auto` (default) maps when there are 2+ related test files, `on` maps for 1+, `off` never.
   */
  coverageMap?: CoverageMapMode;
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
  /** Mutants run in parallel (after the parallel-safety check). */
  concurrency: number;
  coverageMap: {
    enabled: boolean;
    /** Related test files whose probe output was usable. */
    mappedTests: number;
    /** Mutants that ran fewer test files than the full related set (including no-coverage ones). */
    narrowed: number;
    /** Mutants no related test file executes; reported as survived without a run. */
    noCoverage: number;
  };
  /** Things the user should know: fallbacks, disabled features. */
  notes: string[];
  mutants: MutantResult[];
}

/** Half the cores, 1–4: test runners start their own workers, and every mutant worker needs a project copy. */
export function defaultConcurrency(): number {
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
}

/** Run `job` for every item with at most `workers` in flight; `worker` is a stable slot index. */
async function pool<T>(items: T[], workers: number, job: (item: T, worker: number) => Promise<void>, aborted: () => boolean): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(workers, items.length)) }, async (_, worker) => {
      while (next < items.length && !aborted()) {
        const item = items[next++]!;
        await job(item, worker);
      }
    }),
  );
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

function cleanEnv(extraPath: string[], extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
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
  delete env[COVERAGE_ENV];
  return { ...env, ...extraEnv };
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

function runCommand(command: string, cwd: string, timeoutMs: number, extraPath: string[], extraEnv?: Record<string, string>): Promise<RunOutcome> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      env: cleanEnv(extraPath, extraEnv),
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
  if (opts.concurrency !== undefined && !(Number.isInteger(opts.concurrency) && opts.concurrency >= 1)) {
    throw new MutationError(`--concurrency must be a whole number of at least 1 (got ${opts.concurrency}).`);
  }

  const root = opts.root ? resolve(cwd, opts.root) : findProjectRoot(dirname(target));
  if (!root || !isProjectRoot(root)) throw new MutationError(`Could not find a package.json (or deno.json) above ${opts.target}; pass --root.`);
  const relTarget = relative(root, target);
  if (relTarget.startsWith('..')) throw new MutationError(`Target ${opts.target} is outside project root ${root}.`);

  // Which tests exercise this file?
  const relatedTests = findRelatedTests(root, target, adapter).map((f) => toPosix(relative(root, f)));

  // `commandFor(files)` runs just those test files, or is null when the command can't be scoped.
  let command: string;
  let commandFor: (files: string[]) => string | null;
  if (opts.testCmd) {
    const template = opts.testCmd;
    commandFor = template.includes('{files}') ? (files) => template.replace('{files}', files.map(shellQuote).join(' ')) : () => null;
    command = template.replace('{files}', relatedTests.map(shellQuote).join(' '));
  } else {
    const fallback = adapter.defaultTestCommand?.(root) ?? null;
    if (!fallback) throw new MutationError('Could not determine how to run tests (no "test" script in package.json or deno.json). Pass --test-cmd "<command>".');
    const script = resolveTestScript(root);
    commandFor = (files) => scopedTestCommand(script, files.map(shellQuote));
    command = commandFor(relatedTests) ?? fallback;
  }

  const source = readFileSync(target, 'utf8');
  const all = adapter.generateMutants(target, source);
  const mutants = all.slice(0, opts.maxMutants ?? 100);
  const sourceLines = source.split(/\r?\n/);
  const notes: string[] = [];

  const tmp = mkdtempSync(join(tmpdir(), 'honest-tests-'));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  let aborted = false;
  const onSignal = (sig: NodeJS.Signals) => {
    aborted = true;
    killRunningTests();
    cleanup();
    process.kill(process.pid, sig);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const works = [prepareCopy(root, join(tmp, 'w0'))];
    // Real bin dirs, not the symlinked copy: pnpm's .bin shims resolve paths relative to their own
    // location, and from inside the temp dir `../../node_modules/.pnpm` points nowhere.
    const extraPath = binPaths(root);

    const baseline = await runCommand(command, works[0]!, opts.timeoutMs ?? 5 * 60_000, extraPath);
    if (baseline.code !== 0) {
      throw new MutationError(
        baseline.timedOut
          ? `Test command timed out before any mutation (${command}). If it starts a watcher or needs services, pass --test-cmd "<command that runs once>".`
          : `Tests fail before any mutation (exit ${baseline.code}). Fix them first — mutation results would be meaningless.`,
        baseline.output,
      );
    }
    let slowest = baseline.durationMs;

    // Parallel runs must not see each other: a suite that binds a fixed port or shares a database
    // would fail mutants that are really survivors, and inflate the score. Prove it with a parallel baseline.
    let concurrency = Math.max(1, Math.min(opts.concurrency ?? defaultConcurrency(), mutants.length));
    if (concurrency > 1) {
      for (let w = 1; w < concurrency; w++) works.push(prepareCopy(root, join(tmp, `w${w}`)));
      const parallel = await Promise.all(works.map((dir) => runCommand(command, dir, opts.timeoutMs ?? Math.max(60_000, baseline.durationMs * 10), extraPath)));
      if (parallel.some((r) => r.code !== 0)) {
        notes.push(
          `Tests fail when ${concurrency} copies run at once (shared ports, files or services?); ran mutants one at a time. Pass --concurrency 1 to skip this check.`,
        );
        concurrency = 1;
      } else slowest = Math.max(slowest, ...parallel.map((r) => r.durationMs));
    }
    const timeoutMs = opts.timeoutMs ?? Math.max(10_000, slowest * 4 + 5_000);

    const writeTarget = (worker: number, text: string) => writeFileSync(join(works[worker]!, relTarget), text);

    // Coverage map: which related test files execute which statements of the target.
    const coverage = await mapCoverage({
      mode: opts.coverageMap ?? 'auto',
      target,
      source,
      relatedTests,
      commandFor,
      concurrency,
      timeoutMs,
      extraPath,
      covDir: join(tmp, 'cov'),
      writeTarget,
      workDir: (w) => works[w]!,
      notes,
      aborted: () => aborted,
    });

    const results: MutantResult[] = new Array(mutants.length);
    let done = 0;
    let narrowed = 0;
    let noCoverage = 0;
    const report = (index: number, r: MutantResult) => {
      results[index] = r;
      done++;
      opts.onProgress?.(done, mutants.length, r);
    };
    const base = (m: Mutant) => ({ ...m, file: toPosix(relative(cwd, target)), sourceLine: (sourceLines[m.line - 1] ?? '').trim() });

    try {
      await pool(
        mutants.map((m, index) => ({ m, index })),
        concurrency,
        async ({ m, index }, worker) => {
          const files = coverage ? coverage.testsFor(m) : null;
          if (files && files.length < relatedTests.length) narrowed++;
          if (files && files.length === 0) {
            noCoverage++;
            report(index, { ...base(m), status: 'survived', durationMs: 0, noCoverage: true, testFiles: [] });
            return;
          }
          const cmd = files && files.length < relatedTests.length ? commandFor(files)! : command;
          let outcome: RunOutcome;
          try {
            writeTarget(worker, source.slice(0, m.start) + m.replacement + source.slice(m.end));
            outcome = await runCommand(cmd, works[worker]!, timeoutMs, extraPath);
          } finally {
            writeTarget(worker, source);
          }
          const status: MutantStatus = outcome.timedOut ? 'timeout' : outcome.code === 0 ? 'survived' : 'killed';
          report(index, {
            ...base(m),
            status,
            durationMs: outcome.durationMs,
            ...(files && files.length < relatedTests.length ? { testFiles: files } : {}),
          });
        },
        () => aborted,
      );
    } catch (e) {
      aborted = true;
      killRunningTests();
      throw e;
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
      concurrency,
      coverageMap: { enabled: !!coverage, mappedTests: coverage?.mappedTests ?? 0, narrowed, noCoverage },
      notes,
      mutants: results,
    };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    cleanup();
  }
}

interface CoverageInput {
  mode: CoverageMapMode;
  target: string;
  source: string;
  relatedTests: string[];
  commandFor: (files: string[]) => string | null;
  concurrency: number;
  timeoutMs: number;
  extraPath: string[];
  covDir: string;
  writeTarget: (worker: number, text: string) => void;
  workDir: (worker: number) => string;
  notes: string[];
  aborted: () => boolean;
}

interface CoverageMap {
  mappedTests: number;
  /** Related test files that can kill `m`, in related-test order. */
  testsFor(m: Mutant): string[];
}

/**
 * Run each related test file alone against an instrumented copy of the target and record which
 * statements it reaches. Returns null (and adds a note when it's surprising) when the map can't be
 * trusted; mutants then run every related test file, as without a map.
 */
async function mapCoverage(o: CoverageInput): Promise<CoverageMap | null> {
  const minTests = o.mode === 'on' ? 1 : 2;
  if (o.mode === 'off' || o.relatedTests.length < minTests) return null;
  const perFile = o.relatedTests.map((f) => o.commandFor([f]));
  if (perFile.some((c) => c === null)) {
    if (o.mode === 'on') o.notes.push('Coverage map needs a test command that takes test files (vitest/jest, or --test-cmd with {files}); ran every related test file per mutant.');
    return null;
  }
  let inst: Instrumented;
  try {
    inst = instrument(o.target, o.source);
  } catch (e) {
    o.notes.push(`Coverage map off: could not instrument the target (${(e as Error).message}).`);
    return null;
  }
  mkdirSync(o.covDir, { recursive: true });
  for (let w = 0; w < o.concurrency; w++) o.writeTarget(w, inst.code);
  const hits = new Map<string, Set<number>>();
  let failed: string | null = null;
  try {
    await pool(
      o.relatedTests.map((file, i) => ({ file, i })),
      o.concurrency,
      async ({ file, i }, worker) => {
        if (failed) return;
        const out = join(o.covDir, `${i}.txt`);
        const r = await runCommand(perFile[i]!, o.workDir(worker), o.timeoutMs, o.extraPath, { [COVERAGE_ENV]: out });
        if (r.code !== 0) failed = file;
        hits.set(file, existsSync(out) ? parseHits(readFileSync(out, 'utf8')) : new Set());
      },
      o.aborted,
    );
  } finally {
    for (let w = 0; w < o.concurrency; w++) o.writeTarget(w, o.source);
  }
  if (failed) {
    o.notes.push(`Coverage map off: ${failed} fails when run alone or against the instrumented target; ran every related test file per mutant.`);
    return null;
  }
  // A file without the load probe recorded nothing we can trust (no `process` in a browser/jsdom-only
  // environment, Node < 22.3, another runtime): it counts as executing everything.
  const mapped = new Set(o.relatedTests.filter((f) => hits.get(f)?.has(LOADED_PROBE)));
  if (mapped.size === 0) {
    o.notes.push('Coverage map off: the instrumented target recorded nothing (test processes need Node 22.3+); ran every related test file per mutant.');
    return null;
  }
  return {
    mappedTests: mapped.size,
    testsFor(m) {
      const probe = probeFor(m, inst);
      if (probe === null) return o.relatedTests;
      return o.relatedTests.filter((f) => !mapped.has(f) || hits.get(f)!.has(probe));
    },
  };
}
