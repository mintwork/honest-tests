import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMENT_MARKER, failingFindings, headline, renderComment, upsertComment, type CommentApi } from '../src/action/comment.js';
import type { AuditResult } from '../src/core/engine.js';
import type { Finding } from '../src/core/types.js';

function finding(over: Partial<Finding>): Finding {
  return {
    ruleId: 'no-assertions',
    severity: 'error',
    file: 'test/a.test.ts',
    line: 3,
    column: 1,
    message: 'Test "x" has no assertions.',
    evidence: "it('x', () => {",
    fix: 'Assert.',
    test: 'x',
    ...over,
  };
}

function result(findings: Finding[], changed: Partial<NonNullable<AuditResult['changed']>> = {}): AuditResult {
  return {
    tool: 'honest-tests',
    version: '0.0.0',
    cwd: '/repo',
    filesScanned: 1,
    testsScanned: 20,
    findings,
    unsupported: [],
    parseErrors: [],
    changed: {
      base: 'abc1234def',
      mergeBase: '0123456789abcdef0123456789abcdef01234567',
      testFiles: ['test/a.test.ts'],
      testsAdded: 12,
      testsModified: 0,
      suspiciousAdded: 4,
      suspiciousModified: 0,
      ...changed,
    },
    summary: { error: 0, warning: 0, info: 0, suspiciousTests: 0 },
  };
}

describe('headline', () => {
  it('says how many tests the PR adds and how many of them can\'t fail', () => {
    expect(headline(result([]))).toBe("This PR adds 12 tests — 4 can't fail.");
    expect(headline(result([], { testsAdded: 1, suspiciousAdded: 0, testsModified: 2, suspiciousModified: 1 }))).toBe(
      "This PR adds 1 test — none flagged as unable to fail; it modifies 2 tests — 1 can't fail.",
    );
    expect(headline(result([], { testsAdded: 0, suspiciousAdded: 0, testsModified: 3, suspiciousModified: 0 }))).toBe(
      'This PR modifies 3 tests — none flagged as unable to fail.',
    );
    expect(headline(result([], { testsAdded: 0, suspiciousAdded: 0 }))).toBe('This PR changes 1 test file but no individual tests.');
    expect(headline(result([], { testFiles: [] }))).toBe('This PR changes no test files.');
  });
});

describe('renderComment', () => {
  const findings = [
    finding({ change: 'added', test: 'adds | pipes', message: 'Compares `r` to itself <b>.', ruleId: 'tautological-assertion', line: 7 }),
    finding({ test: 'old one', line: 40 }),
  ];
  const body = renderComment(result(findings), { repo: 'o/r', sha: 'deadbeef', pathPrefix: 'packages/core', runUrl: 'https://example.test/run/1' });

  it('starts with the marker and the headline', () => {
    expect(body.split('\n').slice(0, 4)).toEqual([COMMENT_MARKER, '### Honest Tests Audit', '', "**This PR adds 12 tests — 4 can't fail.**"]);
  });

  it('lists findings in changed tests with escaped cells and links to the line', () => {
    expect(body).toContain(
      '| error | added | adds \\| pipes | Compares `r` to itself &lt;b>. `tautological-assertion` | [`packages/core/test/a.test.ts:7`](https://github.com/o/r/blob/deadbeef/packages/core/test/a.test.ts#L7) |',
    );
  });

  it('folds findings in untouched tests into a details block', () => {
    const details = body.slice(body.indexOf('<details>'), body.indexOf('</details>'));
    expect(details).toContain("1 finding in tests this PR didn't touch");
    expect(details).toContain('| error | old one |');
    expect(details).not.toContain('tautological-assertion');
    expect(body).toContain('[Workflow run](https://example.test/run/1)');
  });

  it('says so when changed tests are clean', () => {
    const clean = renderComment(result([], { suspiciousAdded: 0 }));
    expect(clean).toContain('No findings in the tests this PR adds or modifies.');
    expect(clean).not.toContain('| Severity |');
  });

  it('caps the table and points to the full report', () => {
    const many = Array.from({ length: 55 }, (_, i) => finding({ change: 'added', line: i + 1, test: `t${i}` }));
    const text = renderComment(result(many));
    expect(text.match(/^\| error \| added \|/gm)).toHaveLength(50);
    expect(text).toContain('… and 5 more');
    // without repo/sha there are no links
    expect(text).toContain('| `test/a.test.ts:1` |');
  });
});

describe('failingFindings', () => {
  const r = result([finding({ change: 'added' }), finding({ change: 'modified', severity: 'warning' }), finding({ severity: 'error' })]);
  it('only counts findings in added or modified tests, at or above the threshold', () => {
    expect(failingFindings(r, 'error').map((f) => f.change)).toEqual(['added']);
    expect(failingFindings(r, 'warning').map((f) => f.change)).toEqual(['added', 'modified']);
    expect(failingFindings(r, 'never')).toEqual([]);
  });
});

describe('upsertComment', () => {
  function fakeApi(existing: Array<{ id: number; body: string; user: { type: string } }>) {
    const calls: string[] = [];
    const api: CommentApi = {
      list: async () => existing,
      create: async (body) => void calls.push(`create:${body}`),
      update: async (id, body) => void calls.push(`update:${id}:${body}`),
    };
    return { api, calls };
  }

  it("updates the bot's earlier comment instead of adding another", async () => {
    const { api, calls } = fakeApi([
      { id: 1, body: `quoting ${COMMENT_MARKER}`, user: { type: 'User' } },
      { id: 2, body: `${COMMENT_MARKER}\nold`, user: { type: 'Bot' } },
    ]);
    expect(await upsertComment(api, 'new')).toBe('updated');
    expect(calls).toEqual(['update:2:new']);
  });

  it('creates a comment when there is none, unless there is nothing to report', async () => {
    const first = fakeApi([{ id: 1, body: 'lgtm', user: { type: 'User' } }]);
    expect(await upsertComment(first.api, 'body')).toBe('created');
    expect(first.calls).toEqual(['create:body']);
    const quiet = fakeApi([]);
    expect(await upsertComment(quiet.api, 'body', true)).toBe('skipped');
    expect(quiet.calls).toEqual([]);
  });
});

describe('dist/action/main.js (the action entry point)', () => {
  it('audits a pull request diff, writes outputs, summary, JSON and SARIF, and fails on new fake tests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ht-action-'));
    const repo = join(dir, 'repo');
    try {
      mkdirSync(join(repo, 'test'), { recursive: true });
      const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
      git('init', '-q', '-b', 'main');
      writeFileSync(join(repo, 'test/old.test.ts'), "it('old fake', () => {\n  run();\n});\n");
      git('add', '.');
      git('commit', '-q', '-m', 'base');
      const baseSha = git('rev-parse', 'HEAD');
      writeFileSync(join(repo, 'test/new.test.ts'), "it('new fake', () => {\n  expect(true).toBe(true);\n});\n\nit('new honest', () => {\n  expect(add(1, 1)).toBe(2);\n});\n");
      git('add', '.');
      git('commit', '-q', '-m', 'pr');
      const event = join(dir, 'event.json');
      writeFileSync(event, JSON.stringify({ pull_request: { number: 7, base: { sha: baseSha, ref: 'main' }, head: { sha: 'x' } } }));
      const output = join(dir, 'output');
      const summary = join(dir, 'summary.md');
      writeFileSync(output, '');
      const r = spawnSync(process.execPath, [resolve(__dirname, '..', 'dist/action/main.js')], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          GITHUB_EVENT_PATH: event,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_WORKSPACE: repo,
          GITHUB_REPOSITORY: 'o/r',
          GITHUB_SHA: 'cafe',
          RUNNER_TEMP: dir,
          HT_SARIF_FILE: 'out.sarif',
          HT_COMMENT: 'true', // no token: the comment is skipped, nothing is sent anywhere
        },
      });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("This PR adds 2 tests — 1 can't fail.");
      expect(r.stdout).toContain('::error file=test/new.test.ts,line=2,col=3,title=tautological-assertion::');
      expect(r.stdout).not.toContain('old.test.ts');
      const outputs = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map((l) => l.split('=') as [string, string]));
      expect(outputs).toMatchObject({ 'tests-added': '2', 'tests-modified': '0', 'cant-fail-added': '1', 'cant-fail-modified': '0', findings: '1' });
      expect(JSON.parse(readFileSync(outputs.report!, 'utf8')).changed.testFiles).toEqual(['test/new.test.ts']);
      expect(JSON.parse(readFileSync(join(repo, 'out.sarif'), 'utf8')).runs[0].results).toHaveLength(1);
      expect(readFileSync(summary, 'utf8')).toContain('[`test/new.test.ts:2`](https://github.com/o/r/blob/cafe/test/new.test.ts#L2)');

      // fail-on never: same report, green step
      const never = spawnSync(process.execPath, [resolve(__dirname, '..', 'dist/action/main.js')], {
        cwd: repo,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, GITHUB_EVENT_PATH: event, RUNNER_TEMP: dir, HT_FAIL_ON: 'never' },
      });
      expect(never.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
