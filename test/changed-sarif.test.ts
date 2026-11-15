import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changeKind, parseUnifiedDiff, unquoteGitPath } from '../src/core/git.js';
import { run } from '../src/run.js';

const ROOT = resolve(__dirname, '..');

async function cli(args: string[], cwd = ROOT) {
  let stdout = '';
  let stderr = '';
  const code = await run(args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), cwd });
  return { code, stdout, stderr };
}

describe('parseUnifiedDiff', () => {
  const diff = [
    'diff --git a/test/a.test.ts b/test/a.test.ts',
    'index 1111111..2222222 100644',
    '--- a/test/a.test.ts',
    '+++ b/test/a.test.ts',
    '@@ -3,0 +4,2 @@ describe',
    '+  it(\'new\', () => {',
    '+  });',
    '@@ -10 +12 @@',
    '+    expect(x).toBe(2);',
    '@@ -20,2 +21,0 @@',
    '-    expect(y).toBe(1);',
    '-    expect(z).toBe(1);',
    'diff --git a/gone.test.ts b/gone.test.ts',
    '--- a/gone.test.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-x',
    'diff --git "a/sp ace/\\303\\251.test.ts" "b/sp ace/\\303\\251.test.ts"',
    '--- "a/sp ace/\\303\\251.test.ts"',
    '+++ "b/sp ace/\\303\\251.test.ts"',
    '@@ -1 +1 @@',
    '+y',
  ].join('\n');
  const files = parseUnifiedDiff(diff);

  it('collects added lines in new-file numbering, and marks lines around pure deletions as touched', () => {
    const a = files.get('test/a.test.ts');
    expect(a).not.toBe('all');
    if (!a || a === 'all') return;
    expect([...a.added].sort((x, y) => x - y)).toEqual([4, 5, 12]);
    expect([...a.touched].sort((x, y) => x - y)).toEqual([21, 22]);
  });

  it('skips deleted files and decodes quoted non-ASCII paths', () => {
    expect([...files.keys()]).toEqual(['test/a.test.ts', 'sp ace/é.test.ts']);
    expect(unquoteGitPath('"a\\tb"')).toBe('a\tb');
    expect(unquoteGitPath('plain.ts')).toBe('plain.ts');
  });

  it('classifies a test as added when its first line is new, modified when only its body changed', () => {
    const a = files.get('test/a.test.ts')!;
    expect(changeKind(a, 4, 5)).toBe('added');
    expect(changeKind(a, 11, 14)).toBe('modified');
    expect(changeKind(a, 20, 21)).toBe('modified');
    expect(changeKind(a, 30, 40)).toBeNull();
    expect(changeKind('all', 1, 1)).toBe('added');
    expect(changeKind(undefined, 1, 1)).toBeNull();
  });
});

describe('honest-tests audit --changed', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'pipe' });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'ht-changed-'));
    mkdirSync(join(repo, 'test'));
    git('init', '-q', '-b', 'main');
    writeFileSync(
      join(repo, 'test/old.test.ts'),
      ["it('old and fake', () => {", '  run();', '});', '', "it('kept honest', () => {", '  expect(add(1, 2)).toBe(3);', '  expect(add(2, 2)).toBe(4);', '});', ''].join('\n'),
    );
    writeFileSync(join(repo, 'test/untouched.test.ts'), "it('fake but not in this PR', () => {\n  run();\n});\n");
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'feature');
    // committed on the branch: a new file with one honest and one fake test
    writeFileSync(join(repo, 'test/new.test.ts'), "it('new honest', () => {\n  expect(add(1, 1)).toBe(2);\n});\n\nit('new fake', () => {\n  const r = add(1, 1);\n  expect(r).toBe(r);\n});\n");
    git('add', '.');
    git('commit', '-q', '-m', 'feature');
    // uncommitted: delete an assertion from an existing test, append a new fake test
    writeFileSync(
      join(repo, 'test/old.test.ts'),
      ["it('old and fake', () => {", '  run();', '});', '', "it('kept honest', () => {", '  expect(add(1, 2)).toBe(3);', '});', '', "it('appended', () => {", '  add(5, 5);', '});', ''].join('\n'),
    );
    // untracked
    writeFileSync(join(repo, 'test/untracked.test.ts'), "it('untracked fake', () => {\n  expect(true).toBe(true);\n});\n");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('audits only changed test files and counts added, modified and suspicious tests', async () => {
    const r = await cli(['audit', '--changed', 'main', '--json'], repo);
    expect(r.code).toBe(1);
    const json = JSON.parse(r.stdout);
    expect(json.changed.testFiles.sort()).toEqual(['test/new.test.ts', 'test/old.test.ts', 'test/untracked.test.ts']);
    expect(json.changed).toMatchObject({ base: 'main', testsAdded: 4, testsModified: 1, suspiciousAdded: 3, suspiciousModified: 0 });
    expect(json.changed.mergeBase).toMatch(/^[0-9a-f]{40}$/);
    // The pre-existing fake test in a changed file is still reported, but not attributed to the change.
    const byTest = Object.fromEntries(json.findings.map((f: { test: string; change?: string }) => [f.test, f.change ?? null]));
    expect(byTest).toEqual({ 'old and fake': null, appended: 'added', 'new fake': 'added', 'untracked fake': 'added' });
  });

  it('prints a change summary for humans', async () => {
    const r = await cli(['audit', '--changed', 'main'], repo);
    expect(r.stdout).toContain('Changed since main');
    expect(r.stdout).toContain('3 test files, 4 tests added, 1 modified.');
    expect(r.stdout).toContain("3 of 4 added tests can't fail.");
    expect(r.stdout).toContain('[added]');
    expect(r.stdout).not.toContain('untouched.test.ts');
  });

  it('combines with path arguments', async () => {
    const r = await cli(['audit', 'test/new.test.ts', '--changed', 'main', '--json'], repo);
    expect(JSON.parse(r.stdout).changed.testFiles).toEqual(['test/new.test.ts']);
  });

  it('reports a clean result when no test file changed', async () => {
    const r = await cli(['audit', '--changed', 'HEAD', 'test/untouched.test.ts'], repo);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('No test files changed since HEAD');
  });

  it('exits 2 on an unknown ref, an option-like ref, or outside a git repository', async () => {
    const bad = await cli(['audit', '--changed', 'no-such-branch'], repo);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('merge base');
    expect((await cli(['audit', '--changed=--output=/tmp/x'], repo)).code).toBe(2);
    const outside = mkdtempSync(join(tmpdir(), 'ht-nogit-'));
    try {
      expect((await cli(['audit', '--changed', 'main'], outside)).code).toBe(2);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    expect((await cli(['mutate', 'x.ts', '--changed', 'main'], repo)).code).toBe(2);
  });
});

interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: string;
  message: { text: string };
  locations: Array<{ physicalLocation: { artifactLocation: { uri: string; uriBaseId?: string }; region: { startLine: number; startColumn: number } } }>;
}

describe('honest-tests --sarif', () => {
  it('emits SARIF 2.1.0 with one result per finding, linked to its rule', async () => {
    const json = JSON.parse((await cli(['audit', 'fixtures/bad-project', '--json'])).stdout);
    const r = await cli(['audit', 'fixtures/bad-project', '--sarif']);
    expect(r.code).toBe(1);
    const sarif = JSON.parse(r.stdout);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.$schema).toContain('sarif-2.1.0');
    const [runObj] = sarif.runs;
    expect(runObj.tool.driver.name).toBe('honest-tests');
    expect(runObj.originalUriBaseIds.SRCROOT.uri).toMatch(/^file:\/\/.*\/$/);
    const rules = runObj.tool.driver.rules as Array<{ id: string; defaultConfiguration: { level: string } }>;
    expect(rules.find((x) => x.id === 'skipped-test')?.defaultConfiguration.level).toBe('warning');
    const results = runObj.results as SarifResult[];
    expect(results).toHaveLength(json.findings.length);
    for (const res of results) expect(rules[res.ruleIndex]!.id).toBe(res.ruleId);
    const first = results[0]!;
    const f = json.findings[0];
    expect(first.ruleId).toBe(f.ruleId);
    expect(first.level).toBe(f.severity === 'info' ? 'note' : f.severity);
    expect(first.locations[0]!.physicalLocation).toEqual({
      artifactLocation: { uri: f.file, uriBaseId: 'SRCROOT' },
      region: { startLine: f.line, startColumn: f.column },
    });
    expect(first.message.text).toContain(f.message);
  });

  it('rejects --json together with --sarif', async () => {
    expect((await cli(['audit', 'fixtures/bad-project', '--json', '--sarif'])).code).toBe(2);
  });

  it('reports surviving mutants as results', { timeout: 120_000 }, async () => {
    const r = await cli(['mutate', 'fixtures/bad-project/src/pricing.ts', '--max-mutants', '3', '--sarif']);
    const sarif = JSON.parse(r.stdout);
    const results = sarif.runs[0].results as SarifResult[];
    expect(results.length).toBeGreaterThan(0);
    expect(new Set(results.map((x) => x.ruleId))).toEqual(new Set(['surviving-mutant']));
    expect(results[0]!.locations[0]!.physicalLocation.artifactLocation.uri).toBe('fixtures/bad-project/src/pricing.ts');
    expect(results[0]!.message.text).toMatch(/^Mutant survived: /);
  });
});
