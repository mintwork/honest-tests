import { parseSource, walk, type Node } from '../adapters/js/ast.js';
import type { Mutant } from '../core/types.js';

/**
 * Per-test-file coverage mapping for mutation runs.
 *
 * The target is copied with a probe in front of every statement inside a function body (and around
 * every arrow expression body). Each related test file is run alone with `HONEST_TESTS_COV` pointing at
 * a file; the probes append the ids they reach. A mutant then only needs the test files that reached
 * the statement containing it: a file that never reaches that statement runs exactly as it would on
 * the original code, so it can't kill the mutant.
 *
 * Soundness rules (when unsure, run every related test file):
 * - Mutants outside any function (module top level) run at import time: every importer reaches them.
 * - A mutant maps to a probed region only when both sit in the same function. Default parameters,
 *   hoisted function declarations and similar spots fall back to every related test file.
 */

export const COVERAGE_ENV = 'HONEST_TESTS_COV';
/** Probe id recorded when the instrumented module finishes loading. */
export const LOADED_PROBE = 0;

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
]);

/** TypeScript-only statements: nothing runs, so there's nothing to probe. */
const TYPE_ONLY = /^TS(TypeAlias|Interface|Declare|Module|Enum|ImportEquals|ExportAssignment|NamespaceExport)/;

export interface ProbeRegion {
  id: number;
  start: number;
  end: number;
  /** Start offset of the function that owns the region. */
  fn: number;
}

export interface Instrumented {
  code: string;
  regions: ProbeRegion[];
  /** [start, end] of every function in the file. */
  functions: Array<[number, number]>;
}

function probeFunction(ts: boolean): string {
  const any = ts ? ': any' : '';
  return [
    '',
    `var __htSeen${any};`,
    `function __htProbe(i${ts ? ': number' : ''})${ts ? ': void' : ''} {`,
    '  try {',
    '    if (!__htSeen) __htSeen = new Set();',
    '    if (__htSeen.has(i)) return;',
    '    __htSeen.add(i);',
    `    var p${any} = (globalThis${ts ? ' as any' : ''}).process;`,
    `    var out = p && p.env && p.env.${COVERAGE_ENV};`,
    "    var fs = out && p.getBuiltinModule && p.getBuiltinModule('node:fs');",
    "    if (fs) fs.appendFileSync(out, i + '\\n');",
    '  } catch (e) {}',
    '}',
    `__htProbe(${LOADED_PROBE});`,
    '',
  ].join('\n');
}

function isSuperCall(stmt: Node): boolean {
  return stmt.type === 'ExpressionStatement' && stmt.expression.type === 'CallExpression' && stmt.expression.callee.type === 'Super';
}

/** Copy of `source` with coverage probes, plus where each probe's region lies. Offsets refer to `source`. */
export function instrument(path: string, source: string): Instrumented {
  const ast = parseSource(path, source);
  const ts = /\.[mc]?tsx?$/i.test(path);
  const regions: ProbeRegion[] = [];
  const functions: Array<[number, number]> = [];
  // [offset, order, text]: at one offset, closing parens go before probes and opening parens.
  const inserts: Array<[number, number, string]> = [];
  let next = LOADED_PROBE + 1;

  const enclosingFn = (ancestors: Node[]): Node | undefined => {
    for (let i = ancestors.length - 1; i >= 0; i--) if (FUNCTION_TYPES.has(ancestors[i]!.type)) return ancestors[i];
    return undefined;
  };
  const probeStatements = (stmts: Node[], fn: Node) => {
    for (const s of stmts) {
      if (TYPE_ONLY.test(s.type) || s.type === 'EmptyStatement' || isSuperCall(s)) continue;
      const id = next++;
      regions.push({ id, start: s.start!, end: s.end!, fn: fn.start! });
      inserts.push([s.start!, 1, `;__htProbe(${id});`]);
    }
  };

  walk(ast, (node, ancestors) => {
    if (FUNCTION_TYPES.has(node.type)) {
      functions.push([node.start!, node.end!]);
      if (node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement') {
        const body = node.body as Node;
        const id = next++;
        regions.push({ id, start: body.start!, end: body.end!, fn: node.start! });
        inserts.push([body.start!, 2, `(__htProbe(${id}), `], [body.end!, 0, ')']);
      }
      return;
    }
    if (node.type !== 'BlockStatement' && node.type !== 'SwitchCase') return;
    const fn = enclosingFn(ancestors);
    if (!fn) return; // top-level blocks run at import time
    probeStatements(node.type === 'BlockStatement' ? (node.body as Node[]) : (node.consequent as Node[]), fn);
  });

  inserts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let code = '';
  let pos = 0;
  for (const [offset, , text] of inserts) {
    code += source.slice(pos, offset) + text;
    pos = offset;
  }
  code += source.slice(pos) + probeFunction(ts);
  return { code, regions, functions };
}

/**
 * The probe whose hits decide which test files can kill `m`, or null when every related test file
 * has to run (top-level code, or no region in the mutant's own function contains it).
 */
export function probeFor(m: Pick<Mutant, 'start' | 'end'>, inst: Pick<Instrumented, 'regions' | 'functions'>): number | null {
  let fn: [number, number] | null = null;
  for (const f of inst.functions) {
    if (f[0] <= m.start && m.end <= f[1] && (!fn || f[1] - f[0] < fn[1] - fn[0])) fn = f;
  }
  if (!fn) return null;
  let best: ProbeRegion | null = null;
  for (const r of inst.regions) {
    if (r.fn !== fn[0] || r.start > m.start || m.end > r.end) continue;
    if (!best || r.end - r.start < best.end - best.start) best = r;
  }
  return best ? best.id : null;
}

/** Parse a probe output file: one id per line. */
export function parseHits(text: string): Set<number> {
  const out = new Set<number>();
  for (const line of text.split('\n')) {
    const n = Number(line.trim());
    if (line.trim() && Number.isInteger(n)) out.add(n);
  }
  return out;
}
