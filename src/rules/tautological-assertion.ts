import type { RawFinding, Rule } from '../core/types.js';
import { atAssertion, code, eachTest } from './helpers.js';

/**
 * Expected values that are the actual value restated: `toHaveLength(list.length)`, `toEqual(list.slice())`.
 * Transformations (`toEqual(keys.toSorted())`, `toEqual(xs.map(lower))`) are real property checks.
 */
function isCopyOf(actual: string, expected: string, kind: string): boolean {
  if (kind === 'length') return expected === `${actual}.length` || expected === `${actual}.size`;
  return [`${actual}.slice()`, `${actual}.concat()`, `${actual}.valueOf()`, `[...${actual}]`, `{...${actual}}`, `structuredClone(${actual})`].includes(expected);
}

export const tautologicalAssertion: Rule = {
  id: 'tautological-assertion',
  severity: 'error',
  description: 'Assertion compares a value to itself or asserts on a constant, so its outcome is fixed before any code runs.',
  fix: 'Compare the output of the code under test against an independently known expected value (a literal you worked out by hand, or a fixture).',
  check(file) {
    const out: RawFinding[] = [];
    for (const t of eachTest(file)) {
      for (const a of t.assertions) {
        const s = a.subject;
        if (!s || a.matcherKind === 'none') continue;
        if (s.kind === 'literal') {
          // With a planned assertion count (t.plan(n), expect.assertions(n)), `t.ok(true)` in a callback or
          // catch, or among several assertions, is a counted checkpoint: the count fails the test if it
          // never runs. A constant as the only, top-level check stays a finding.
          if (t.hasAssertionCountGuard && (a.context.inCallback || a.context.inCatch || t.assertions.length > 1)) continue;
          out.push(atAssertion(t, a, `Asserts on the constant ${code(s.text)} — no code under test is involved, so this can never fail.`));
          continue;
        }
        const expected = a.args[0];
        if (!expected) continue;
        if (a.matcherKind !== 'equal' && a.matcherKind !== 'length') continue;
        if (expected.text === s.text) {
          out.push(atAssertion(t, a, `Compares ${code(s.text)} to itself — this can never fail.`));
        } else if ((s.kind === 'identifier' || s.kind === 'member') && isCopyOf(s.text, expected.text, a.matcherKind)) {
          out.push(atAssertion(t, a, `Expected value ${code(expected.text)} is derived from the actual value ${code(s.text)} — the assertion checks nothing.`));
        }
      }
    }
    return out;
  },
};
