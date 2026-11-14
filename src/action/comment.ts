import type { AuditResult } from '../core/engine.js';
import type { Finding, Severity } from '../core/types.js';

/** Hidden marker that identifies the action's own PR comment, so reruns update it instead of adding one. */
export const COMMENT_MARKER = '<!-- honest-tests-audit -->';
const MAX_ROWS = 50;

export interface CommentOptions {
  /** `owner/repo`, for links. */
  repo?: string;
  /** Commit the line links point at. */
  sha?: string;
  /** GitHub web URL (`https://github.com` or a GHES host). */
  serverUrl?: string;
  /** Path of the audited directory relative to the repository root ('' when it is the root). */
  pathPrefix?: string;
  /** Link to the workflow run, shown in the footer. */
  runUrl?: string;
}

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Findings in tests the change adds or modifies, at or above `failOn`. */
export function failingFindings(result: AuditResult, failOn: 'error' | 'warning' | 'never'): Finding[] {
  if (failOn === 'never') return [];
  return result.findings.filter((f) => f.change && RANK[f.severity] <= RANK[failOn]);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Make text safe inside a Markdown table cell. */
function cell(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/</g, '&lt;');
}

function joinPath(prefix: string, file: string): string {
  return prefix ? `${prefix.replace(/\/$/, '')}/${file}` : file;
}

function location(f: Finding, o: CommentOptions): string {
  const path = joinPath(o.pathPrefix ?? '', f.file);
  const label = `${path}:${f.line}`;
  if (!o.repo || !o.sha || path.startsWith('/')) return `\`${label}\``;
  const url = `${o.serverUrl ?? 'https://github.com'}/${o.repo}/blob/${o.sha}/${path.split('/').map(encodeURIComponent).join('/')}#L${f.line}`;
  return `[\`${label}\`](${url})`;
}

function table(findings: Finding[], o: CommentOptions, withChange: boolean): string[] {
  const rows = findings.slice(0, MAX_ROWS).map(
    (f) =>
      `| ${f.severity} | ${withChange ? `${f.change} | ` : ''}${cell(f.test ?? '(file)')} | ${cell(f.message)} \`${f.ruleId}\` | ${location(f, o)} |`,
  );
  const head = withChange ? ['| Severity | Change | Test | Finding | Location |', '| --- | --- | --- | --- | --- |'] : ['| Severity | Test | Finding | Location |', '| --- | --- | --- | --- |'];
  const more = findings.length > MAX_ROWS ? [``, `… and ${findings.length - MAX_ROWS} more (see the job summary or the JSON report).`] : [];
  return [...head, ...rows, ...more];
}

/** The headline: "This PR adds 12 tests — 4 can't fail." */
export function headline(result: AuditResult): string {
  const ch = result.changed;
  if (!ch || ch.testFiles.length === 0) return 'This PR changes no test files.';
  const part = (verb: string, n: number, bad: number) => `${verb} ${plural(n, 'test')} — ${bad === 0 ? 'none flagged as unable to fail' : `${bad} can't fail`}`;
  const parts: string[] = [];
  if (ch.testsAdded) parts.push(part('adds', ch.testsAdded, ch.suspiciousAdded));
  if (ch.testsModified) parts.push(part('modifies', ch.testsModified, ch.suspiciousModified));
  if (parts.length === 0) return `This PR changes ${plural(ch.testFiles.length, 'test file')} but no individual tests.`;
  return `This PR ${parts.join('; it ')}.`;
}

export function renderComment(result: AuditResult, o: CommentOptions = {}): string {
  const out = [COMMENT_MARKER, '### Honest Tests Audit', '', `**${headline(result)}**`];
  const ch = result.changed;
  const inChange = result.findings.filter((f) => f.change);
  const elsewhere = result.findings.filter((f) => !f.change);
  if (ch && ch.testFiles.length) {
    out.push('', `Audited ${plural(ch.testFiles.length, 'changed test file')} against \`${ch.base}\` (merge base \`${ch.mergeBase.slice(0, 7)}\`).`);
  }
  if (inChange.length) out.push('', ...table(inChange, o, true));
  else if (ch && ch.testsAdded + ch.testsModified > 0) out.push('', 'No findings in the tests this PR adds or modifies.');
  if (elsewhere.length) {
    out.push(
      '',
      `<details><summary>${plural(elsewhere.length, 'finding')} in tests this PR didn't touch (same files)</summary>`,
      '',
      ...table(elsewhere, o, false),
      '',
      '</details>',
    );
  }
  if (result.parseErrors.length) out.push('', `Could not parse: ${result.parseErrors.map((p) => `\`${p.file}\``).join(', ')}.`);
  if (result.unsupported.length) out.push('', `Not audited (language not supported yet): ${plural(result.unsupported.length, 'file')}.`);
  out.push(
    '',
    `<sub>"Can't fail" means an error-level finding: the test passes whether or not the code it names works. ` +
      `Reproduce locally with \`npx @mintwork/honest-tests audit --changed ${ch?.base ?? 'origin/main'}\`. ` +
      `Suppress a deliberate case with \`// honest-tests-disable-next-line <rule> -- reason\`.` +
      `${o.runUrl ? ` [Workflow run](${o.runUrl}).` : ''}</sub>`,
  );
  return out.join('\n') + '\n';
}

export interface CommentApi {
  list(): Promise<Array<{ id: number; body?: string | null; user?: { type?: string } | null }>>;
  create(body: string): Promise<void>;
  update(id: number, body: string): Promise<void>;
}

/**
 * Update the action's earlier comment, or create one. With `onlyUpdate` (nothing to report),
 * an existing comment is refreshed but no new one is posted, so unrelated PRs stay quiet.
 */
export async function upsertComment(api: CommentApi, body: string, onlyUpdate = false): Promise<'created' | 'updated' | 'skipped'> {
  const existing = (await api.list()).find((c) => c.user?.type === 'Bot' && c.body?.includes(COMMENT_MARKER));
  if (existing) {
    await api.update(existing.id, body);
    return 'updated';
  }
  if (onlyUpdate) return 'skipped';
  await api.create(body);
  return 'created';
}
