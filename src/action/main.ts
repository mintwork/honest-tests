/**
 * Entry point of the "Honest Tests Audit" GitHub Action (action.yml at the repo root).
 *
 * Audits the test files a pull request changes (`audit --changed <base>`), writes the job summary,
 * a JSON report and optionally SARIF, and creates or updates one PR comment. It only parses test
 * files; it never runs the repository's code or tests.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { audit } from '../core/engine.js';
import { changedFiles, GitError, type ChangedFiles } from '../core/git.js';
import { toSarif } from '../report/sarif.js';
import { rules } from '../rules/index.js';
import { version } from '../run.js';
import { failingFindings, headline, renderComment, upsertComment, type CommentApi } from './comment.js';

const env = process.env;
const input = (name: string) => (env[`HT_${name}`] ?? '').trim();
const list = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

function setOutput(name: string, value: string | number) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/** Escape workflow-command data (`%`, CR, LF) and, for properties, `:` and `,`. */
function esc(s: string, property = false): string {
  const data = s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return property ? data.replace(/:/g, '%3A').replace(/,/g, '%2C') : data;
}

function log(level: 'notice' | 'warning' | 'error', msg: string) {
  process.stdout.write(`::${level}::${esc(msg)}\n`);
}

interface PullEvent {
  pull_request?: { number: number; base: { sha: string; ref: string }; head: { sha: string } };
  before?: string;
}

function readEvent(): PullEvent {
  try {
    return env.GITHUB_EVENT_PATH ? (JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as PullEvent) : {};
  } catch {
    return {};
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** `git merge-base` needs history; shallow checkouts (the actions/checkout default) don't have it. */
function changedWithHistory(cwd: string, base: string): ChangedFiles {
  try {
    return changedFiles(cwd, base);
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    let shallow = false;
    try {
      shallow = git(cwd, ['rev-parse', '--is-shallow-repository']) === 'true';
    } catch {
      throw e;
    }
    if (!shallow) throw e;
    log('notice', 'Shallow checkout: fetching history to find the merge base (use actions/checkout with fetch-depth: 0 to skip this).');
    git(cwd, ['fetch', '--no-tags', '--quiet', '--unshallow', 'origin']);
    if (/^[0-9a-f]{40}$/.test(base)) {
      try {
        git(cwd, ['cat-file', '-e', `${base}^{commit}`]);
      } catch {
        git(cwd, ['fetch', '--no-tags', '--quiet', 'origin', base]);
      }
    }
    return changedFiles(cwd, base);
  }
}

function githubApi(token: string, repo: string, issue: number): CommentApi {
  const api = env.GITHUB_API_URL ?? 'https://api.github.com';
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' };
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!res.ok) throw new Error(`${method} ${url.replace(api, '')} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res;
  };
  return {
    async list() {
      const all: Array<{ id: number; body?: string | null; user?: { type?: string } | null }> = [];
      for (let page = 1; page <= 20; page++) {
        const batch = (await (await call('GET', `${api}/repos/${repo}/issues/${issue}/comments?per_page=100&page=${page}`)).json()) as typeof all;
        all.push(...batch);
        if (batch.length < 100) break;
      }
      return all;
    },
    async create(body) {
      await call('POST', `${api}/repos/${repo}/issues/${issue}/comments`, { body });
    },
    async update(id, body) {
      await call('PATCH', `${api}/repos/${repo}/issues/comments/${id}`, { body });
    },
  };
}

async function main(): Promise<number> {
  const event = readEvent();
  const cwd = resolve(input('WORKING_DIRECTORY') || '.');
  const workspace = resolve(env.GITHUB_WORKSPACE ?? cwd);
  const failOn = (input('FAIL_ON') || 'error') as 'error' | 'warning' | 'never';
  if (!['error', 'warning', 'never'].includes(failOn)) {
    log('error', `fail-on must be error, warning or never (got "${failOn}").`);
    return 2;
  }
  const zero = /^0+$/;
  const base = input('BASE') || event.pull_request?.base.sha || (event.before && !zero.test(event.before) ? event.before : '');
  if (!base) {
    log('error', 'No base to compare against: run on pull_request events or set the `base` input (e.g. origin/main).');
    return 2;
  }

  let changed: ChangedFiles;
  try {
    changed = changedWithHistory(cwd, base);
  } catch (e) {
    log('error', `Could not compute the changed files: ${(e as Error).message}`);
    return 2;
  }
  // Show (and suggest reproducing with) the branch name rather than the base commit's SHA.
  if (!input('BASE') && event.pull_request?.base.ref) changed = { ...changed, base: `origin/${event.pull_request.base.ref}` };
  const paths = list(input('PATHS') || '.');
  const result = audit({ paths, cwd, ignore: list(input('IGNORE')), changed }, version());

  const reportPath = join(env.RUNNER_TEMP ?? tmpdir(), 'honest-tests.json');
  writeFileSync(reportPath, JSON.stringify({ schemaVersion: 1, ...result }, null, 2));
  setOutput('report', reportPath);
  const sarifFile = input('SARIF_FILE');
  if (sarifFile) {
    const out = resolve(cwd, sarifFile);
    writeFileSync(out, toSarif(result, null, rules, version(), cwd) + '\n');
    setOutput('sarif-file', out);
  }

  const ch = result.changed!;
  setOutput('tests-added', ch.testsAdded);
  setOutput('tests-modified', ch.testsModified);
  setOutput('cant-fail-added', ch.suspiciousAdded);
  setOutput('cant-fail-modified', ch.suspiciousModified);
  setOutput('findings', result.findings.filter((f) => f.change).length);

  const prefix = relative(workspace, cwd).split('\\').join('/');
  const runUrl = env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
  const body = renderComment(result, {
    repo: env.GITHUB_REPOSITORY,
    sha: env.GITHUB_SHA,
    serverUrl: env.GITHUB_SERVER_URL,
    pathPrefix: prefix.startsWith('..') ? '' : prefix,
    runUrl,
  });
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, body);
  process.stdout.write(`${headline(result)}\n`);

  const pr = event.pull_request?.number;
  const wantComment = (input('COMMENT') || 'true') !== 'false';
  const token = input('GITHUB_TOKEN');
  if (wantComment && pr && token && env.GITHUB_REPOSITORY) {
    try {
      const outcome = await upsertComment(githubApi(token, env.GITHUB_REPOSITORY, pr), body, ch.testFiles.length === 0);
      process.stdout.write(`PR comment: ${outcome}\n`);
    } catch (e) {
      // Pull requests from forks get a read-only token; the job summary still has the report.
      log('warning', `Could not post the PR comment (${(e as Error).message}). The report is in the job summary.`);
    }
  }

  const failing = failingFindings(result, failOn);
  if (failing.length) {
    for (const f of failing.slice(0, 50)) {
      const file = prefix && !prefix.startsWith('..') ? `${prefix}/${f.file}` : f.file;
      const level = f.severity === 'error' ? 'error' : 'warning';
      process.stdout.write(`::${level} file=${esc(file, true)},line=${f.line},col=${f.column},title=${esc(f.ruleId, true)}::${esc(f.message)}\n`);
    }
    log('error', `${failing.length} finding(s) at or above "${failOn}" in tests this PR adds or modifies.`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    log('error', `honest-tests action failed: ${(err as Error)?.stack ?? String(err)}`);
    process.exitCode = 2;
  },
);
