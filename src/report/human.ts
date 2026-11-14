import type { AuditResult } from '../core/engine.js';
import type { Severity } from '../core/types.js';
import type { MutationReport } from '../mutate/runner.js';
import { c } from './colors.js';

const SEV: Record<Severity, (s: string) => string> = {
  error: (s) => c.red(s),
  warning: (s) => c.yellow(s),
  info: (s) => c.blue(s),
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function formatAudit(r: AuditResult, opts: { verbose?: boolean } = {}): string {
  const out: string[] = [];
  let currentFile = '';
  for (const f of r.findings) {
    if (f.file !== currentFile) {
      currentFile = f.file;
      out.push('', c.bold(c.cyan(f.file)));
    }
    const tag = f.change ? c.magenta(`[${f.change}] `) : '';
    out.push(`  ${c.gray(`${f.line}:${f.column}`.padEnd(7))} ${SEV[f.severity](f.severity.padEnd(7))} ${tag}${f.message} ${c.dim(f.ruleId)}`);
    out.push(`          ${c.gray('│')} ${c.dim(f.evidence)}`);
    if (opts.verbose) out.push(`          ${c.gray('└')} ${c.green('fix:')} ${f.fix}`);
  }
  for (const u of r.unsupported) {
    out.push(c.gray(`  skipped ${u.file} (${u.language} support is on the roadmap)`));
  }
  for (const p of r.parseErrors) {
    out.push(c.yellow(`  could not parse ${p.file}: ${p.message}`));
  }

  out.push('');
  const { error, warning, suspiciousTests } = r.summary;
  const ch = r.changed;
  if (ch) {
    const since = `since ${ch.base} (merge base ${ch.mergeBase.slice(0, 7)})`;
    if (ch.testFiles.length === 0 && r.parseErrors.length === 0) {
      out.push(c.green(`✓ No test files changed ${since}.`));
      return out.join('\n').replace(/^\n/, '');
    }
    out.push(
      c.bold(`Changed ${since}: ${plural(ch.testFiles.length, 'test file')}, ${plural(ch.testsAdded, 'test')} added, ${ch.testsModified} modified.`),
    );
    if (ch.suspiciousAdded + ch.suspiciousModified > 0) {
      const parts = [ch.suspiciousAdded ? `${c.red(String(ch.suspiciousAdded))} of ${ch.testsAdded} added` : '', ch.suspiciousModified ? `${c.red(String(ch.suspiciousModified))} of ${ch.testsModified} modified` : ''].filter(Boolean);
      out.push(c.bold(`${parts.join(' and ')} tests can't fail.`));
    }
  }
  if (r.filesScanned === 0 && r.parseErrors.length === 0) {
    // "✓ 0 tests: no fake tests found" reads as a pass; it's really "nothing was checked".
    out.push(
      c.yellow(
        'No test files found. honest-tests looks for *.test.* / *.spec.* / test.* files and __tests__/ dirs ' +
          '(vitest, jest, node:test, mocha-style it/describe). Pass test files or directories explicitly if yours are named differently.',
      ),
    );
  } else if (r.findings.length === 0) {
    out.push(c.green(c.bold(`✓ ${plural(r.testsScanned, 'test')} in ${plural(r.filesScanned, 'file')}: no fake tests found.`)));
  } else {
    if (suspiciousTests > 0) {
      out.push(c.bold(`${c.red(String(suspiciousTests))} of ${r.testsScanned} tests can't fail (or don't test what they claim).`));
    }
    out.push(
      `${plural(r.filesScanned, 'file')}, ${plural(r.testsScanned, 'test')}: ${SEV.error(plural(error, 'error'))}, ${SEV.warning(plural(warning, 'warning'))}.` +
        (opts.verbose ? '' : c.dim(' Run with --verbose for fixes.')),
    );
  }
  return out.join('\n').replace(/^\n/, '');
}

export function formatMutation(m: MutationReport): string {
  const out: string[] = [];
  out.push('', c.bold(`Mutation check: ${m.target}`));
  out.push(c.dim(`  command: ${m.command}`));
  const shown = m.relatedTests.slice(0, 6).join(', ') + (m.relatedTests.length > 6 ? `, … ${m.relatedTests.length - 6} more` : '');
  if (m.relatedTests.length) out.push(c.dim(`  tests:   ${shown}`));
  else out.push(c.yellow('  no test file imports this target (directly or via other modules); ran the full test command'));
  if (m.generated > m.tested) out.push(c.yellow(`  tested ${m.tested} of ${m.generated} mutants (raise --max-mutants for more)`));

  const survivors = m.mutants.filter((x) => x.status === 'survived');
  if (survivors.length) {
    out.push('', c.bold(c.red(`  ${plural(survivors.length, 'mutant')} survived — your tests don't actually check these lines:`)));
    const byLine = new Map<number, typeof survivors>();
    for (const s of survivors) byLine.set(s.line, [...(byLine.get(s.line) ?? []), s]);
    for (const [line, list] of byLine) {
      out.push('', `  ${c.gray(`${m.target}:${line}`)}  ${list[0]!.sourceLine}`);
      for (const s of list) out.push(`      ${c.red('✗')} ${s.description}`);
    }
  }
  const score = m.score;
  const color = score >= 90 ? c.green : score >= 60 ? c.yellow : c.red;
  out.push('');
  out.push(
    `  ${c.bold('Mutation score:')} ${color(c.bold(`${score}%`))} ` +
      c.dim(`(${m.killed} killed, ${m.timedOut} timed out, ${m.survived} survived of ${m.tested}; baseline ${(m.baselineMs / 1000).toFixed(1)}s)`),
  );
  if (survivors.length === 0) out.push(c.green('  ✓ Every mutation was caught. These tests actually test something.'));
  return out.join('\n');
}
