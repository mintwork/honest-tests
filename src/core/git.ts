import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Lines of one changed file: `all` for new/untracked files, else added lines plus lines next to deletions. */
export type ChangedLines = 'all' | { added: Set<number>; touched: Set<number> };

export interface ChangedFiles {
  /** The ref the user asked for, e.g. `origin/main`. */
  base: string;
  /** `git merge-base <base> HEAD`: what the PR branched from. */
  mergeBase: string;
  /** Repository top-level directory. */
  root: string;
  /** Absolute path -> changed lines. Deleted files are not included. */
  files: Map<string, ChangedLines>;
}

export class GitError extends Error {}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = e as { stderr?: string; code?: string; message: string };
    if (err.code === 'ENOENT') throw new GitError('git is not installed or not on PATH.');
    throw new GitError((err.stderr || err.message).trim().split('\n')[0] ?? err.message);
  }
}

/** Undo git's C-style quoting of unusual paths (`"a\\tb"`, octal escapes for non-ASCII bytes). */
export function unquoteGitPath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const bytes: number[] = [];
  const body = p.slice(1, -1);
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '"': 34, '\\': 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[i + 1] ?? '';
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Parse `git diff -U0` output into per-file changed lines (new-file line numbers).
 * A hunk that only deletes (`+c,0`) marks lines `c` and `c + 1` as touched, so a test whose
 * assertion was deleted still counts as modified.
 */
export function parseUnifiedDiff(diff: string): Map<string, ChangedLines> {
  const out = new Map<string, ChangedLines>();
  let current: { added: Set<number>; touched: Set<number> } | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const raw = unquoteGitPath(line.slice(4).replace(/\t$/, ''));
      if (raw === '/dev/null') {
        current = null;
        continue;
      }
      const path = raw.startsWith('b/') ? raw.slice(2) : raw;
      current = { added: new Set(), touched: new Set() };
      out.set(path, current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count === 0) {
        current.touched.add(start);
        current.touched.add(start + 1);
      }
      for (let i = 0; i < count; i++) current.added.add(start + i);
    }
  }
  return out;
}

/**
 * Files changed between `base` and the working tree: committed, staged and unstaged changes since
 * the merge base, plus untracked files that aren't ignored. Uses `git` with an argument list (no shell).
 */
export function changedFiles(cwd: string, base: string): ChangedFiles {
  if (!base || base.startsWith('-')) throw new GitError(`Invalid base ref "${base}".`);
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  let mergeBase: string;
  try {
    mergeBase = git(root, ['merge-base', base, 'HEAD']).trim();
  } catch (e) {
    throw new GitError(
      `Can't find a merge base between "${base}" and HEAD (${(e as Error).message}). ` +
        'Check the ref name; in CI, fetch enough history (actions/checkout with fetch-depth: 0).',
    );
  }
  const diff = git(root, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--find-renames',
    '--diff-filter=AMR',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '-U0',
    mergeBase,
    '--',
  ]);
  const files = new Map<string, ChangedLines>();
  for (const [rel, lines] of parseUnifiedDiff(diff)) files.set(resolve(root, rel), lines);
  for (const rel of git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')) {
    if (rel) files.set(resolve(root, rel), 'all');
  }
  return { base, mergeBase, root, files };
}

/** How a test spanning `[start, end]` was changed, if at all. */
export function changeKind(lines: ChangedLines | undefined, start: number, end: number): 'added' | 'modified' | null {
  if (!lines) return null;
  if (lines === 'all' || lines.added.has(start)) return 'added';
  for (let l = start; l <= end; l++) if (lines.added.has(l) || lines.touched.has(l)) return 'modified';
  return null;
}
