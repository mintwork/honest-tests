import type { RawFinding, Rule } from '../core/types.js';
import { atAssertion, code, eachTest } from './helpers.js';

const ALWAYS_DEFINED = new Set(['object', 'array', 'function', 'new', 'typeof']);
const ALWAYS_TRUTHY = new Set(['object', 'array', 'function', 'new']);

export const neverFailingAssertion: Rule = {
  id: 'never-failing-assertion',
  severity: 'error',
  description: 'Assertion is structurally unable to fail: missing matcher call, un-awaited async matcher, or a check that is always true.',
  fix: 'Make the assertion specific: call the matcher, await async matchers, and assert the exact expected value instead of "is defined"/"is truthy".',
  check(file) {
    const out: RawFinding[] = [];
    for (const t of eachTest(file)) {
      for (const a of t.assertions) {
        const s = a.subject;
        if (a.style === 'expect' && a.matcherKind === 'none') {
          out.push(
            atAssertion(
              t,
              a,
              a.matcher
                ? `Matcher ${code('.' + a.matcher)} is referenced but never called — add \`()\`. As written it asserts nothing.`
                : '`expect(...)` without a matcher asserts nothing.',
            ),
          );
          continue;
        }
        if (a.async && !a.awaitedOrReturned) {
          out.push(atAssertion(t, a, `Async matcher (.resolves/.rejects) is not awaited or returned — the test can finish before it runs.`));
          continue;
        }
        if (!s || a.negated) continue;
        if (a.matcherKind === 'defined' && ALWAYS_DEFINED.has(s.kind)) {
          out.push(atAssertion(t, a, `${code(s.text)} is always defined — this assertion can never fail.`));
        } else if (a.matcherKind === 'truthy' && (ALWAYS_TRUTHY.has(s.kind) || s.alwaysTruthy)) {
          out.push(atAssertion(t, a, `${code(s.text)} is always truthy — this assertion can never fail.`));
        } else if (
          (a.matcherKind === 'compare-gte' || a.matcherKind === 'compare-other') &&
          (/\.(length|size)$/.test(s.text) || /^len\(.+\)$/.test(s.text)) &&
          a.args[0] &&
          ((a.matcherKind === 'compare-gte' && a.args[0].literalValue === 0) ||
            (a.matcher === 'toBeGreaterThan' && typeof a.args[0].literalValue === 'number' && a.args[0].literalValue < 0))
        ) {
          out.push(atAssertion(t, a, `${code(s.text)} is never negative — this assertion can never fail.`));
        }
      }
    }
    return out;
  },
};
