import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { excerpt, run } from '../src/run.js';

const ROOT = resolve(__dirname, '..');

async function cli(args: string[], cwd = ROOT) {
  let stdout = '';
  let stderr = '';
  const code = await run(args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), cwd });
  return { code, stdout, stderr };
}

describe('honest-tests audit', () => {
  it('exits 1 and prints a human report when errors are found', async () => {
    const r = await cli(['audit', 'fixtures/bad-project']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('fixtures/bad-project/test/pricing.test.ts');
    expect(r.stdout).toContain("11 of 15 tests can't fail");
  });

  it('says so when no test files were found instead of reporting a clean pass', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ht-empty-'));
    try {
      writeFileSync(join(dir, 'index.ts'), 'export const x = 1;\n');
      const r = await cli(['audit', dir]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('No test files found');
      expect(r.stdout).not.toContain('no fake tests found');
      // files outside cwd are shown by absolute path, not ../../..
      writeFileSync(join(dir, 'a.test.ts'), "it('a', () => { run(); });\n");
      const outside = await cli(['audit', dir, '--json']);
      expect(JSON.parse(outside.stdout).findings[0].file).toBe(join(dir, 'a.test.ts').split('\\').join('/'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 0 on honest tests', async () => {
    const r = await cli(['audit', 'fixtures/good-project']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no fake tests found');
  });

  it('emits JSON with schema version, summary and findings', async () => {
    const r = await cli(['audit', 'fixtures/bad-project', '--json']);
    const json = JSON.parse(r.stdout);
    expect(json.schemaVersion).toBe(1);
    expect(json.tool).toBe('honest-tests');
    expect(json.summary.error).toBe(13);
    for (const f of json.findings) {
      expect(Object.keys(f)).toEqual(expect.arrayContaining(['ruleId', 'severity', 'file', 'line', 'column', 'message', 'evidence', 'fix']));
    }
    // every finding except the file-level vi.mock one names its test
    expect(json.findings.filter((f: { test?: string }) => !f.test).map((f: { ruleId: string }) => f.ruleId)).toEqual(['mocked-unit-under-test']);
  });

  it('supports --rule, --disable and --fail-on', async () => {
    const only = JSON.parse((await cli(['audit', 'fixtures/bad-project', '--json', '--rule', 'skipped-test'])).stdout);
    expect(only.findings.map((f: { ruleId: string }) => f.ruleId)).toEqual(['skipped-test']);

    const warnOnly = await cli(['audit', 'fixtures/bad-project', '--rule', 'skipped-test']);
    expect(warnOnly.code).toBe(0);
    const strict = await cli(['audit', 'fixtures/bad-project', '--rule', 'skipped-test', '--fail-on', 'warning']);
    expect(strict.code).toBe(1);

    const never = await cli(['audit', 'fixtures/bad-project', '--fail-on', 'never']);
    expect(never.code).toBe(0);
  });

  it('rejects unknown rules and options with exit 2', async () => {
    expect((await cli(['audit', '--rule', 'nope'])).code).toBe(2);
    expect((await cli(['audit', '--bogus'])).code).toBe(2);
    expect((await cli(['frobnicate'])).code).toBe(2);
  });

  it('lists rules', async () => {
    const r = await cli(['rules', '--json']);
    const list = JSON.parse(r.stdout) as Array<{ id: string }>;
    expect(list.map((x) => x.id)).toContain('tautological-assertion');
    expect(list.map((x) => x.id)).toContain('asserts-on-own-literal');
    expect(list).toHaveLength(16);
  });
});

describe('honest-tests audit --mutate', { timeout: 120_000 }, () => {
  it('combines audit and mutation output in one JSON document', async () => {
    const r = await cli(['audit', 'fixtures/good-project', '--mutate', 'fixtures/good-project/src/pricing.ts', '--max-mutants', '4', '--json']);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.findings).toEqual([]);
    expect(json.mutation.tested).toBe(4);
    expect(json.mutation.score).toBe(100);
  });

  it('fails with --min-score when mutants survive', async () => {
    const r = await cli(['mutate', 'fixtures/bad-project/src/pricing.ts', '--max-mutants', '3', '--min-score', '80']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("survived — your tests don't actually check these lines");
  });
});

describe('honest-tests init', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('installs the Claude Code skill', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ht-init-'));
    expect((await cli(['init', 'claude'], dir)).code).toBe(0);
    const skill = readFileSync(join(dir, '.claude/skills/honest-tests/SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: honest-tests\n/);
    expect(existsSync(join(dir, '.claude/skills/honest-tests/references/test-smells.md'))).toBe(true);
  });

  it('adds an idempotent section to AGENTS.md for Codex', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ht-init-'));
    writeFileSync(join(dir, 'AGENTS.md'), '# My project\n');
    await cli(['init', 'codex'], dir);
    await cli(['init', 'codex'], dir);
    const md = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(md.startsWith('# My project\n')).toBe(true);
    expect(md.match(/honest-tests:start/g)).toHaveLength(1);
  });

  it('installs the Cursor rule', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ht-init-'));
    await cli(['init', 'cursor'], dir);
    expect(readFileSync(join(dir, '.cursor/rules/honest-tests.mdc'), 'utf8')).toContain('honest-tests audit');
  });
});

describe('error excerpts (field-test regression)', () => {
  it('keeps the first lines (the actual error) as well as the last (the summary)', () => {
    const out = ['Error: browserType.launch: Executable does not exist', ...Array.from({ length: 100 }, (_, i) => `  at frame ${i}`), 'Test Files  1 failed'].join('\n');
    const shown = excerpt(out);
    expect(shown.split('\n')[0]).toBe('Error: browserType.launch: Executable does not exist');
    expect(shown).toContain('Test Files  1 failed');
    expect(shown).toContain('62 lines');
  });
});

describe('dist/cli.js', () => {
  it('exits quietly when stdout is closed early (`honest-tests audit | head`)', () => {
    // `true` exits without reading, so every write from the CLI hits a closed pipe.
    const r = spawnSync('sh', ['-c', `node "${join(ROOT, 'dist', 'cli.js')}" audit fixtures/bad-project | true`], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
});
