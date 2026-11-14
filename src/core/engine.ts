import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { adapterFor } from '../adapters/index.js';
import { rules as allRules } from '../rules/index.js';
import type { Finding, Rule, Severity, TestFileModel } from './types.js';

export const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  'out',
  '.turbo',
  '.cache',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
]);

export interface AuditOptions {
  paths: string[];
  cwd?: string;
  /** Glob-ish patterns relative to cwd (`fixtures/**`, `**\/legacy/*`, or a bare dir name). */
  ignore?: string[];
  /** Restrict to these rule ids. */
  only?: string[];
  /** Exclude these rule ids. */
  disable?: string[];
}

export interface AuditResult {
  tool: 'honest-tests';
  version: string;
  cwd: string;
  filesScanned: number;
  testsScanned: number;
  findings: Finding[];
  /** Test files found for languages whose adapter is still planned (e.g. pytest). */
  unsupported: Array<{ file: string; language: string }>;
  parseErrors: Array<{ file: string; message: string }>;
  summary: {
    error: number;
    warning: number;
    info: number;
    /** Distinct tests with at least one error-level finding. */
    suspiciousTests: number;
  };
}

export function globToRegExp(pattern: string): RegExp {
  let p = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!/[*?]/.test(p)) {
    // bare path/dir name: match it as a path segment sequence anywhere
    const esc = p.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|/)${esc}(/|$)`);
  }
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        re += '.*';
        i++;
        if (p[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}(/|$)`);
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** Path relative to cwd, or absolute when the file is outside it (`../../../tmp/x` helps nobody). */
export function displayPath(cwd: string, abs: string): string {
  const rel = toPosix(relative(cwd, abs));
  return !rel || rel.startsWith('../') || rel === '..' ? toPosix(abs) : rel;
}

export function discoverTestFiles(paths: string[], cwd: string, ignore: string[] = []): string[] {
  const ignoreRes = ignore.map(globToRegExp);
  const isIgnored = (abs: string) => {
    const rel = toPosix(relative(cwd, abs));
    return ignoreRes.some((re) => re.test(rel));
  };
  const out = new Set<string>();
  const visit = (abs: string, explicit: boolean) => {
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      if (!explicit && (DEFAULT_IGNORED_DIRS.has(abs.split(sep).pop()!) || isIgnored(abs))) return;
      for (const entry of readdirSync(abs).sort()) visit(join(abs, entry), false);
      return;
    }
    if (!st.isFile()) return;
    if (!explicit && isIgnored(abs)) return;
    const adapter = adapterFor(abs);
    if (adapter && (explicit || adapter.isTestFile(toPosix(abs)) || adapter.isCandidateTestFile?.(toPosix(abs)))) out.add(abs);
  };
  for (const p of paths) visit(resolve(cwd, p), true);
  return [...out];
}

/** Parse `honest-tests-disable*` comments. Works for `//`, `/* *\/` and `#` comments. */
function suppressions(lines: string[]) {
  const fileLevel = new Set<string>();
  let fileAll = false;
  const perLine = new Map<number, Set<string> | 'all'>();
  const parseIds = (rest: string) =>
    rest
      .replace(/\*\/.*$/, '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => /^[a-z][a-z0-9-]*$/.test(s));
  lines.forEach((line, i) => {
    const m = /honest-tests-(disable-next-line|disable-line|disable)\b(.*)$/.exec(line);
    if (!m) return;
    const ids = parseIds(m[2] ?? '');
    if (m[1] === 'disable') {
      if (ids.length === 0) fileAll = true;
      ids.forEach((id) => fileLevel.add(id));
      return;
    }
    const target = m[1] === 'disable-next-line' ? i + 2 : i + 1;
    perLine.set(target, ids.length === 0 ? 'all' : new Set(ids));
  });
  return (f: Finding) => {
    if (fileAll || fileLevel.has(f.ruleId)) return true;
    const s = perLine.get(f.line);
    return s === 'all' || (s instanceof Set && s.has(f.ruleId));
  };
}

export function runRules(model: TestFileModel, rules: Rule[], displayPath: string): Finding[] {
  const suppressed = suppressions(model.lines);
  const findings: Finding[] = [];
  for (const rule of rules) {
    for (const raw of rule.check(model)) {
      const f: Finding = {
        ruleId: rule.id,
        severity: raw.severity ?? rule.severity,
        file: displayPath,
        line: raw.line,
        column: raw.column,
        message: raw.message,
        evidence: raw.evidence,
        ...(raw.test !== undefined ? { test: raw.test } : {}),
        fix: raw.fix ?? rule.fix,
      };
      if (!suppressed(f)) findings.push(f);
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column || a.ruleId.localeCompare(b.ruleId));
}

export function selectRules(opts: Pick<AuditOptions, 'only' | 'disable'>): Rule[] {
  let selected = allRules;
  if (opts.only?.length) selected = selected.filter((r) => opts.only!.includes(r.id));
  if (opts.disable?.length) selected = selected.filter((r) => !opts.disable!.includes(r.id));
  return selected;
}

export function auditSource(path: string, source: string, opts: Pick<AuditOptions, 'only' | 'disable'> = {}): Finding[] {
  const adapter = adapterFor(path);
  if (!adapter) throw new Error(`No adapter for ${path}`);
  return runRules(adapter.parseTestFile(path, source), selectRules(opts), path);
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function audit(opts: AuditOptions, version = '0.0.0'): AuditResult {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const files = discoverTestFiles(opts.paths.length ? opts.paths : ['.'], cwd, opts.ignore);
  const rules = selectRules(opts);
  const findings: Finding[] = [];
  const unsupported: AuditResult['unsupported'] = [];
  const parseErrors: AuditResult['parseErrors'] = [];
  let testsScanned = 0;
  let filesScanned = 0;

  for (const abs of files) {
    const adapter = adapterFor(abs)!;
    const display = displayPath(cwd, abs);
    if (adapter.planned) {
      unsupported.push({ file: display, language: adapter.id });
      continue;
    }
    // `test/helpers.js`-style files only count when they hold tests.
    const candidate = !adapter.isTestFile(toPosix(abs)) && !!adapter.isCandidateTestFile?.(toPosix(abs));
    let model: TestFileModel;
    try {
      model = adapter.parseTestFile(abs, readFileSync(abs, 'utf8'));
    } catch (e) {
      if (!candidate) parseErrors.push({ file: display, message: (e as Error).message });
      continue;
    }
    if (candidate && model.tests.length === 0) continue;
    filesScanned++;
    testsScanned += model.tests.filter((t) => t.kind === 'test').length;
    findings.push(...runRules(model, rules, display));
  }

  findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.ruleId.localeCompare(b.ruleId),
  );
  // "Can't fail" = an error-level finding about the test's verification (focus markers don't count).
  const suspicious = new Set(
    findings.filter((f) => f.severity === 'error' && f.test && f.ruleId !== 'focused-test').map((f) => `${f.file}::${f.test}`),
  );
  return {
    tool: 'honest-tests',
    version,
    cwd,
    filesScanned,
    testsScanned,
    findings,
    unsupported,
    parseErrors,
    summary: {
      error: findings.filter((f) => f.severity === 'error').length,
      warning: findings.filter((f) => f.severity === 'warning').length,
      info: findings.filter((f) => f.severity === 'info').length,
      suspiciousTests: suspicious.size,
    },
  };
}
