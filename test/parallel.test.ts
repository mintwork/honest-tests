import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSource } from '../src/adapters/js/ast.js';
import { generateJsMutants } from '../src/adapters/js/mutants.js';
import { COVERAGE_ENV, instrument, parseHits, probeFor } from '../src/mutate/coverage.js';
import { defaultConcurrency, mutate, type MutationReport } from '../src/mutate/runner.js';

const ROOT = resolve(__dirname, '..');

/** Run instrumented script code (no imports/exports) and return its result plus the probe ids it hit. */
function runInstrumented(code: string, tail: string): { result: unknown; hits: Set<number> } {
  const dir = mkdtempSync(join(tmpdir(), 'ht-probe-'));
  const out = join(dir, 'hits.txt');
  const before = process.env[COVERAGE_ENV];
  process.env[COVERAGE_ENV] = out;
  try {
    const result = new Function(`${code}\n${tail}`)();
    let text = '';
    try {
      text = readFileSync(out, 'utf8');
    } catch {
      /* nothing hit */
    }
    return { result, hits: parseHits(text) };
  } finally {
    if (before === undefined) delete process.env[COVERAGE_ENV];
    else process.env[COVERAGE_ENV] = before;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Probe id of the first mutant whose original text is `original` on `line`. */
function probeOf(src: string, path: string, line: number, original: string) {
  const m = generateJsMutants(path, src).find((x) => x.line === line && x.original === original);
  if (!m) throw new Error(`no mutant ${original} on line ${line}`);
  return probeFor(m, instrument(path, src));
}

describe('coverage instrumentation', () => {
  const src = [
    'function size(x) {',
    '  if (x > 10) {',
    "    return 'big';",
    '  }',
    "  return 'small';",
    '}',
    'const twice = (y) => y * 2;',
    'function unused(z) {',
    '  return z - 1;',
    '}',
  ].join('\n');

  it('keeps the code valid and its behavior unchanged', () => {
    const { code } = instrument('x.js', src);
    expect(() => parseSource('x.js', code)).not.toThrow();
    const plain = new Function(`${src}\nreturn [size(11), size(3), twice(4)];`)();
    const { result } = runInstrumented(code, 'return [size(11), size(3), twice(4)];');
    expect(result).toEqual(plain);
    expect(result).toEqual(['big', 'small', 8]);
  });

  it('records the statements a run reaches, and the module load', () => {
    const inst = instrument('x.js', src);
    const { hits } = runInstrumented(inst.code, 'size(3); return null;');
    const id = (line: number, original: string) => probeOf(src, 'x.js', line, original)!;
    expect(hits.has(0)).toBe(true); // module finished loading
    expect(hits.has(id(2, '>'))).toBe(true); // the `if` ran
    expect(hits.has(id(3, "'big'"))).toBe(false); // ... but not its branch
    expect(hits.has(id(7, 'y * 2'))).toBe(false); // twice() never called
    expect(hits.has(id(9, '-'))).toBe(false); // unused() never called
    const again = runInstrumented(inst.code, 'twice(1); size(20); return null;');
    expect(again.hits.has(id(7, 'y * 2'))).toBe(true);
    expect(again.hits.has(id(3, "'big'"))).toBe(true);
  });

  it('gives every probe its own id, never the module-load id', () => {
    const { regions } = instrument('x.js', src);
    const ids = regions.map((r) => r.id);
    expect(ids.length).toBeGreaterThan(3);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(0);
  });

  it('leaves top-level blocks alone: they run on import, for every test file', () => {
    const { regions } = instrument('x.js', 'let n = 0;\nif (n === 0) {\n  n = 1;\n}\nfor (const k of [1]) {\n  n += k;\n}\n');
    expect(regions).toEqual([]);
  });

  it('ignores blank lines in probe output', () => {
    expect([...parseHits('3\n\n0\n \n3\n')]).toEqual([3, 0]);
    expect(parseHits('').size).toBe(0);
  });

  it('type-checks in TypeScript files (no implicit any) and parses as TS', () => {
    const { code } = instrument('x.ts', 'export function f(n: number): number {\n  return n + 1;\n}\n');
    expect(code).toContain('function __htProbe(i: number): void');
    expect(code).toContain('(globalThis as any).process');
    expect(() => parseSource('x.ts', code)).not.toThrow();
  });

  it('wraps arrow expression bodies, including object literals, without changing them', () => {
    const arrows = 'const pair = (a) => ({ a, b: a > 1 });\nconst nest = (a) => (b) => a - b;\nconst block = (a) => { return a + 1; };';
    const { code } = instrument('x.js', arrows);
    const { result } = runInstrumented(code, 'return [pair(2), nest(5)(3), block(1)];');
    expect(result).toEqual([{ a: 2, b: true }, 2, 2]);
  });

  it('does not probe before super() or between a label and its loop', () => {
    const cls = [
      'class A { constructor(v) { this.v = v; } }',
      'class B extends A {',
      '  constructor(v) {',
      '    super(v > 1);',
      '    outer: for (let i = 0; i < 3; i++) { for (;;) { continue outer; } }',
      '  }',
      '}',
    ].join('\n');
    const { code } = instrument('x.js', cls);
    expect(code).toMatch(/\{\s*super\(v > 1\);/);
    expect(code).toContain('outer: for');
    expect(() => parseSource('x.js', code)).not.toThrow();
    const { result } = runInstrumented(code, 'return new B(2).v;');
    expect(result).toBe(true);
  });
});

describe('mapping mutants to probes', () => {
  it('sends top-level code and spots outside any statement of the own function to every test file', () => {
    const src = [
      'export const LIMIT = 10;', // top level: runs on import
      'export function f(x, d = 2) {', // default parameter
      '  return helper(x) + d;',
      '  function helper(y) {',
      '    return y * 3;',
      '  }',
      '}',
    ].join('\n');
    expect(probeOf(src, 'x.js', 1, '10')).toBeNull();
    expect(probeOf(src, 'x.js', 2, '2')).toBeNull();
    expect(probeOf(src, 'x.js', 3, '+')).not.toBeNull();
    // inside the hoisted helper: its own statement, not the declaration statement in f
    const inner = probeOf(src, 'x.js', 5, '*');
    expect(inner).not.toBeNull();
    const inst = instrument('x.js', src);
    const region = inst.regions.find((r) => r.id === inner)!;
    expect(src.slice(region.start, region.end)).toBe('return y * 3;');
  });
});

describe('parallel mutation runs', { timeout: 300_000 }, () => {
  const statuses = (r: MutationReport) => r.mutants.map((m) => `${m.id}:${m.status}`);

  it('defaults to a bounded worker count', () => {
    expect(defaultConcurrency()).toBeGreaterThanOrEqual(1);
    expect(defaultConcurrency()).toBeLessThanOrEqual(4);
  });

  it('gives the same verdict for every mutant as a serial run, with and without the coverage map', async () => {
    for (const target of ['fixtures/bad-project/src/pricing.ts', 'fixtures/good-project/src/pricing.ts']) {
      const serial = await mutate({ target, cwd: ROOT, concurrency: 1, coverageMap: 'off' });
      const parallel = await mutate({ target, cwd: ROOT, concurrency: 2, coverageMap: 'on' });
      expect(serial.concurrency).toBe(1);
      expect(parallel.concurrency).toBe(2);
      expect(parallel.coverageMap.enabled).toBe(true);
      expect(statuses(parallel)).toEqual(statuses(serial));
      expect(parallel.score).toBe(serial.score);
    }
  });

  it('runs each mutant only against the test files that execute its line', async () => {
    const target = 'fixtures/mapped-project/src/stats.ts';
    const serial = await mutate({ target, cwd: ROOT, concurrency: 1, coverageMap: 'off' });
    const mapped = await mutate({ target, cwd: ROOT, concurrency: 2 });
    expect(statuses(mapped)).toEqual(statuses(serial));
    expect(mapped.relatedTests).toEqual(['test/clamp.test.ts', 'test/mean.test.ts', 'test/round.test.ts']);
    expect(mapped.coverageMap).toMatchObject({ enabled: true, mappedTests: 3, noCoverage: 2 });
    const files = (line: number) => [...new Set(mapped.mutants.filter((m) => m.line === line).map((m) => (m.testFiles ?? ['all']).join(',')))];
    expect(files(2)).toEqual(['all']); // top-level constant: every importer runs it
    expect(files(5)).toEqual(['test/mean.test.ts']);
    expect(files(6)).toEqual(['test/mean.test.ts']); // includes the reduce callback's arrow body
    expect(files(10)).toEqual(['test/clamp.test.ts']);
    expect(files(16)).toEqual(['all']); // default parameter
    expect(files(18)).toEqual(['test/round.test.ts']);
    const outlier = mapped.mutants.filter((m) => m.line === 22);
    expect(outlier.map((m) => [m.status, m.noCoverage, m.durationMs])).toEqual([
      ['survived', true, 0],
      ['survived', true, 0],
    ]);
  });

  it('falls back to one worker when the suite is not parallel-safe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ht-par-'));
    const lock = join(mkdtempSync(join(tmpdir(), 'ht-lock-')), 'held');
    try {
      mkdirSync(join(dir, 'test'));
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', type: 'module', scripts: { test: 'node test/check.mjs' } }));
      writeFileSync(join(dir, 'add.js'), 'export const add = (a, b) => a + b;\n');
      // Holds a lock outside the project copy, like a fixed port or a shared database would.
      writeFileSync(
        join(dir, 'test', 'check.mjs'),
        [
          "import { mkdirSync, rmdirSync } from 'node:fs';",
          "import { add } from '../add.js';",
          `mkdirSync(${JSON.stringify(lock)});`,
          'await new Promise((r) => setTimeout(r, 1500));',
          `rmdirSync(${JSON.stringify(lock)});`,
          'if (add(2, 3) !== 5) process.exit(1);',
        ].join('\n'),
      );
      const report = await mutate({ target: join(dir, 'add.js'), cwd: dir, concurrency: 2 });
      expect(report.concurrency).toBe(1);
      expect(report.notes.join('\n')).toContain('Tests fail when 2 copies run at once');
      expect(report.mutants.map((m) => m.status)).toEqual(['killed', 'killed']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(join(lock, '..'), { recursive: true, force: true });
    }
  });

  it('rejects a concurrency below 1', async () => {
    await expect(mutate({ target: 'fixtures/good-project/src/pricing.ts', cwd: ROOT, concurrency: 0 })).rejects.toThrow('--concurrency');
  });
});
