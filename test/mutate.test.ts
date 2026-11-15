import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { jsAdapter, resolveTestScript, scopedTestCommand } from '../src/adapters/js/index.js';
import { applyMutant, generateJsMutants } from '../src/adapters/js/mutants.js';
import { findRelatedTests, killRunningTests, mutate } from '../src/mutate/runner.js';

const ROOT = resolve(__dirname, '..');

describe('generateJsMutants', () => {
  const describeAll = (src: string) => generateJsMutants('x.ts', src).map((m) => `${m.line}:${m.column} ${m.original} -> ${m.replacement}`);

  it('flips comparison, arithmetic and logical operators', () => {
    expect(describeAll(`const ok = a >= b && c + d;`)).toEqual(['1:14 >= -> >', '1:19 && -> ||', '1:24 + -> -']);
  });

  it('flips booleans, removes negation, tweaks numbers and replaces return values', () => {
    expect(describeAll(`function f(x) {\n  if (!x) return false;\n  return 41;\n}`)).toEqual([
      '2:7 !x -> true',
      '2:7 !x -> false',
      '2:7 !x -> (x)',
      '2:18 false -> true',
      '3:10 41 -> undefined',
      '3:10 41 -> 42',
    ]);
  });

  it('never touches types, imports, string concatenation or logging', () => {
    const src = [
      `import { a } from './a';`,
      `type N = 1 | 2;`,
      `function g(n: Array<1>): string {`,
      `  console.log(n.length > 0);`,
      `  return 'a' + n;`,
      `}`,
    ].join('\n');
    expect(describeAll(src)).toEqual(["5:10 'a' + n -> undefined"]);
  });

  it('applies a mutant by splicing only its range', () => {
    const src = 'return a < b;';
    const [m] = generateJsMutants('x.ts', src).filter((x) => x.operator === 'binary');
    expect(applyMutant(src, m!)).toBe('return a <= b;');
  });
});

describe('mutate() on fixture projects', { timeout: 180_000 }, () => {
  it('weak tests let most mutants survive', async () => {
    const target = 'fixtures/bad-project/src/pricing.ts';
    const before = readFileSync(resolve(ROOT, target), 'utf8');
    const report = await mutate({ target, cwd: ROOT });
    // checkout.test.ts reaches pricing.ts through checkout.ts (and then mocks checkout away)
    expect(report.relatedTests).toEqual(['test/checkout.test.ts', 'test/pricing.test.ts']);
    expect(report.command).toBe('npm test --silent -- test/checkout.test.ts test/pricing.test.ts');
    expect(report.tested).toBe(26);
    expect(report.survived).toBe(22);
    expect(report.score).toBeLessThan(20);
    const survivedLines = new Set(report.mutants.filter((m) => m.status === 'survived').map((m) => m.line));
    expect(survivedLines).toEqual(new Set([7, 9, 15, 18, 22, 26, 27, 29]));
    // the working tree is never modified
    expect(readFileSync(resolve(ROOT, target), 'utf8')).toBe(before);
  });

  it('honest tests kill every mutant', async () => {
    const report = await mutate({ target: 'fixtures/good-project/src/pricing.ts', cwd: ROOT });
    expect(report.mutants.filter((m) => m.status === 'survived')).toEqual([]);
    expect(report.score).toBe(100);
  });

  it('refuses to run when the tests already fail', async () => {
    await expect(
      mutate({ target: 'fixtures/good-project/src/pricing.ts', cwd: ROOT, testCmd: 'node -e "process.exit(3)"', maxMutants: 1 }),
    ).rejects.toThrow('Tests fail before any mutation');
  });

  it('respects --test-cmd with {files} and --max-mutants', async () => {
    const report = await mutate({
      target: 'fixtures/good-project/src/pricing.ts',
      cwd: ROOT,
      testCmd: 'vitest run {files}',
      maxMutants: 3,
    });
    expect(report.command).toBe('vitest run test/checkout.test.ts test/pricing.test.ts');
    expect(report.tested).toBe(3);
    expect(report.generated).toBe(26);
    expect(report.killed).toBe(3);
  });

  it('runs node:test projects, finding test/*.js files that import the target', async () => {
    const report = await mutate({ target: 'fixtures/node-test-project/src/pricing.js', cwd: ROOT });
    expect(report.relatedTests).toEqual(['test/pricing.js', 'test/shipping.test.mjs']);
    expect(report.command).toBe('npm test --silent -- test/pricing.js test/shipping.test.mjs');
    expect(report.tested).toBe(16);
    // the free-shipping threshold is never checked at its boundary
    expect(report.mutants.filter((m) => m.status === 'survived').map((m) => `${m.line} ${m.original}->${m.replacement}`)).toEqual(['9 >=->>', '9 50->51']);
  });

  it('finds the project root of a Deno project by its deno.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ht-deno-root-'));
    try {
      writeFileSync(join(dir, 'deno.json'), JSON.stringify({ tasks: { test: 'deno test' } }));
      writeFileSync(join(dir, 'mod.ts'), 'export const twice = (n: number) => n * 2;\n');
      writeFileSync(join(dir, 'mod_test.ts'), "import { assertEquals } from 'jsr:@std/assert';\nimport { twice } from './mod.ts';\nDeno.test('twice', () => assertEquals(twice(2), 4));\n");
      const report = await mutate({ target: join(dir, 'mod.ts'), cwd: dir, testCmd: 'node -e "" {files}', maxMutants: 1 });
      expect(report.root).toBe('.');
      expect(report.relatedTests).toEqual(['mod_test.ts']);
      expect(report.command).toBe('node -e "" mod_test.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unsupported targets', async () => {
    const target = 'fixtures/python-project/tests/test_pricing.py';
    expect(existsSync(resolve(ROOT, target))).toBe(true);
    await expect(mutate({ target, cwd: ROOT })).rejects.toThrow('not supported');
  });
});

describe('test command for mutation runs (field-test regressions)', () => {
  const withScripts = (scripts: Record<string, string>, files: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'ht-scripts-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));
      return scopedTestCommand(resolveTestScript(dir), files);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('adds --run to a bare `vitest` script so the baseline does not hang in watch mode', () => {
    expect(withScripts({ test: 'vitest' }, ['a.test.ts'])).toBe('npm test --silent -- --run a.test.ts');
    expect(withScripts({ test: 'vitest run' }, ['a.test.ts'])).toBe('npm test --silent -- a.test.ts');
  });

  it('turns coverage off, so subset runs do not trip global coverage thresholds', () => {
    expect(withScripts({ test: 'vitest run --coverage' }, ['a.test.ts'])).toBe('npm test --silent -- --coverage.enabled=false a.test.ts');
    expect(withScripts({ test: 'jest --coverage' }, ['a.test.ts'])).toBe('npm test --silent -- --coverage=false a.test.ts');
  });

  it('follows `npm run x` delegation and runs the leaf script directly', () => {
    expect(withScripts({ test: 'npm run test:vitest', 'test:vitest': 'vitest run' }, ['t/a.test.js'])).toBe('vitest run t/a.test.js');
    expect(withScripts({ test: 'pnpm test:unit', 'test:unit': 'jest --ci' }, [])).toBe('jest --ci');
  });

  it('passes related test files to mocha and node --test', () => {
    expect(withScripts({ test: 'mocha' }, ['test/a.js'])).toBe('npm test --silent -- test/a.js');
    expect(withScripts({ test: 'npm run test:unit', 'test:unit': "mocha -r ts-node/register 'test/**/*.ts'" }, ['test/a.ts'])).toBe(
      "mocha -r ts-node/register 'test/**/*.ts' test/a.ts",
    );
    expect(withScripts({ test: 'node --test' }, ['test/a.js'])).toBe('npm test --silent -- test/a.js');
    expect(withScripts({ test: 'node --import tsx --test --test-reporter=spec' }, ['a.test.ts'])).toBe('npm test --silent -- a.test.ts');
    expect(withScripts({ test: 'node --test-reporter=spec index.js' }, ['a.test.ts'])).toBeNull();
  });

  it('drops nyc / c8 wrappers so coverage thresholds do not fail subset runs', () => {
    expect(withScripts({ test: 'nyc --reporter=lcov --check-coverage mocha' }, ['test/a.js'])).toBe('mocha test/a.js');
    expect(withScripts({ test: 'c8 node --test' }, ['test/a.js'])).toBe('node --test test/a.js');
  });

  it('runs bun test directly, with ./ paths so bun treats them as files, not name filters', () => {
    expect(withScripts({ test: 'bun test' }, ['test/a.test.ts', "'test/my file.test.ts'"])).toBe("bun test ./test/a.test.ts './test/my file.test.ts'");
    expect(withScripts({ test: 'bun test --coverage && echo done' }, ['a.test.ts'])).toBeNull();
  });

  it('reads Deno tasks from deno.json / deno.jsonc and falls back to deno test', () => {
    const withDeno = (name: string, text: string | null, files: string[]) => {
      const dir = mkdtempSync(join(tmpdir(), 'ht-deno-'));
      try {
        if (text !== null) writeFileSync(join(dir, name), text);
        return { cmd: scopedTestCommand(resolveTestScript(dir), files), fallback: jsAdapter.defaultTestCommand!(dir) };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    expect(withDeno('deno.json', JSON.stringify({ tasks: { test: 'deno test -A' } }), ['a_test.ts'])).toEqual({ cmd: 'deno test -A a_test.ts', fallback: 'deno task test' });
    const jsonc = `{\n  // tasks\n  "imports": { "std/": "https://deno.land/std/" },\n  "tasks": { "test": { "command": "deno test --allow-read", }, },\n}`;
    expect(withDeno('deno.jsonc', jsonc, ['a_test.ts'])).toEqual({ cmd: 'deno test --allow-read a_test.ts', fallback: 'deno task test' });
    expect(withDeno('deno.json', '{}', ['a_test.ts'])).toEqual({ cmd: 'deno test a_test.ts', fallback: 'deno test' });
    expect(withDeno('deno.json', null, ['a_test.ts'])).toEqual({ cmd: null, fallback: null });
  });

  it('does not extend chained or unknown scripts', () => {
    expect(withScripts({ test: 'npm run t', t: 'tsc && vitest run' }, ['a.test.ts'])).toBeNull();
    expect(withScripts({ test: 'ava' }, ['a.test.ts'])).toBeNull();
  });
});

describe('test file discovery (field-test regressions)', () => {
  it('recognizes co-located test.ts / spec.js files', () => {
    expect(jsAdapter.isTestFile('/repo/src/addDays/test.ts')).toBe(true);
    expect(jsAdapter.isTestFile('/repo/src/parse/spec.mjs')).toBe(true);
    expect(jsAdapter.isTestFile('/repo/src/latest.ts')).toBe(false);
    expect(jsAdapter.isTestFile('/repo/src/contest.ts')).toBe(false);
  });
});

describe('related test selection (field-test regression)', () => {
  it('includes tests that reach the target through other local modules, not just direct importers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ht-related-'));
    try {
      mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
      mkdirSync(join(dir, 'test'));
      writeFileSync(join(dir, 'src', 'lib', 'format.js'), 'export const usd = (v) => `$${v}`;\n');
      writeFileSync(join(dir, 'src', 'Price.jsx'), "import { usd } from './lib/format.js';\nexport const Price = (p) => usd(p.v);\n");
      writeFileSync(join(dir, 'src', 'index.ts'), "export * from './Price';\n");
      writeFileSync(join(dir, 'test', 'price.test.jsx'), "import { Price } from '../src';\n");
      writeFileSync(join(dir, 'test', 'format.test.js'), "import { usd } from '../src/lib/format';\n");
      writeFileSync(join(dir, 'test', 'other.test.js'), "import { x } from '../src/other';\n");
      const related = findRelatedTests(dir, join(dir, 'src', 'lib', 'format.js'), jsAdapter).map((f) => f.slice(dir.length + 1));
      expect(related).toEqual(['test/format.test.js', 'test/price.test.jsx']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mutate() inside a workspace package (field-test regression)', { timeout: 60_000 }, () => {
  it('keeps hoisted node_modules, root configs and sibling packages reachable from the temp copy', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ht-ws-'));
    try {
      writeFileSync(join(ws, 'package.json'), JSON.stringify({ private: true, workspaces: ['pkgs/*'] }));
      writeFileSync(join(ws, 'tsconfig.json'), '{}\n');
      mkdirSync(join(ws, 'pkgs', 'tz'), { recursive: true });
      writeFileSync(join(ws, 'pkgs', 'tz', 'tsconfig.json'), '{}\n'); // sibling referenced by the root tsconfig
      mkdirSync(join(ws, 'node_modules', 'dep'), { recursive: true });
      writeFileSync(join(ws, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep', type: 'module', main: 'index.js' }));
      writeFileSync(join(ws, 'node_modules', 'dep', 'index.js'), 'export default 42;\n');
      const pkg = join(ws, 'pkgs', 'core');
      mkdirSync(join(pkg, 'src'), { recursive: true });
      mkdirSync(join(pkg, 'test'));
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'core', type: 'module', scripts: { test: 'node test/check.mjs' } }));
      writeFileSync(join(pkg, 'src', 'add.js'), 'export const add = (a, b) => a + b;\n');
      writeFileSync(
        join(pkg, 'test', 'check.mjs'),
        [
          "import { readFileSync } from 'node:fs';",
          "import dep from 'dep';",
          "import { add } from '../src/add.js';",
          "readFileSync(new URL('../../../tsconfig.json', import.meta.url));",
          "readFileSync(new URL('../../tz/tsconfig.json', import.meta.url));",
          'if (add(2, 3) !== 5 || dep !== 42) process.exit(1);',
        ].join('\n'),
      );
      const report = await mutate({ target: join(pkg, 'src', 'add.js'), cwd: ws });
      expect(report.root).toBe('pkgs/core');
      expect(report.tested).toBeGreaterThan(0);
      expect(report.score).toBe(100);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('interrupting a mutation run (field-test regression)', { timeout: 60_000 }, () => {
  it('kills the in-flight test process group, not just honest-tests itself', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ht-sigint-'));
    const pidFile = join(dir, 'pid');
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'true' } }));
      writeFileSync(join(dir, 'x.js'), 'export const one = () => 1;\n');
      const sleeper = `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setTimeout(() => {}, 60000)"`;
      const run = mutate({ target: join(dir, 'x.js'), cwd: dir, testCmd: sleeper });
      // Wait for the pid itself, not just the file: an empty read gives pid 0, and kill(0, 0) never throws.
      const readPid = () => (existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0);
      for (let i = 0; i < 200 && !(readPid() > 0); i++) await new Promise((r) => setTimeout(r, 50));
      const pid = readPid();
      expect(pid).toBeGreaterThan(0);
      killRunningTests();
      await expect(run).rejects.toThrow('Tests fail before any mutation');
      // The killed sleeper is orphaned and may linger briefly as a zombie until it's reaped.
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(alive()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
