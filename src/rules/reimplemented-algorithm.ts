import type { RawFinding, Rule } from '../core/types.js';
import { atAssertion, code, eachTest } from './helpers.js';

/**
 * `expect(total(price, qty)).toBe(price * qty * 1.2)`: the expected value is the unit's formula, rewritten
 * in the test over the same inputs. A bug in the formula is copied into the oracle, so the test agrees
 * with the code whatever the formula is.
 *
 * Fires only when all of these hold, so literal arithmetic (`toBe(100 - 20)`, a hand derivation) and
 * relationship checks (`expect(after.length).toBe(before.length + 1)`) stay quiet:
 * - the actual value is the result of a call (directly or via `const r = f(...)`) with arguments;
 * - the expected value is plain numeric arithmetic (no strings, no calls other than `Math.*`);
 * - it reads at least one of the call's own inputs;
 * - it isn't a lone `+` over names only, which may be string concatenation.
 */
export const reimplementedAlgorithm: Rule = {
  id: 'reimplemented-algorithm',
  severity: 'warning',
  description: "Expected value is recomputed in the test with arithmetic over the call's own inputs — it re-implements the code instead of checking it.",
  fix: 'Work the expected value out by hand for concrete inputs and assert that literal (`expect(total(10, 3)).toBe(36)`). Keep formula-based oracles for property tests against an independent reference implementation.',
  check(file) {
    const out: RawFinding[] = [];
    for (const t of eachTest(file)) {
      for (const a of t.assertions) {
        const s = a.subject;
        const expected = a.args[0];
        if (!s || !expected?.arithmetic || a.matcherKind !== 'equal' || a.negated) continue;
        const callee = s.kind === 'call' ? s.calleeText : s.kind === 'identifier' ? s.aliasCalleeText : undefined;
        if (!callee || callee.startsWith('Math.') || !s.callArgRoots?.length) continue;
        const { operators, identifiers, hasNumericLiteral } = expected.arithmetic;
        if (operators.length === 0) continue;
        if (operators.every((op) => op === '+') && !hasNumericLiteral) continue;
        const inputs = new Set(s.callArgRoots);
        const shared = identifiers.filter((id) => inputs.has(id));
        if (shared.length === 0) continue;
        out.push(
          atAssertion(
            t,
            a,
            `Expected value ${code(expected.text)} recomputes ${code(callee)}'s result from its own inputs (${shared.map((x) => code(x, 20)).join(', ')}) — a bug in the formula would be copied into the test.`,
          ),
        );
      }
    }
    return out;
  },
};
