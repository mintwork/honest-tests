import type { RawFinding, Rule } from '../core/types.js';
import { atAssertion, code, eachTest } from './helpers.js';

/**
 * A float carrying binary rounding noise, which nobody types by hand: 12+ decimal places and 13+
 * significant digits ending in a run of zeros or nines plus a stray digit or two
 * (`0.30000000000000004`, `2.9000000000000004`, `79.98999999999999`, `3.2499999999999996`).
 * Plain long decimals (`14.142135623730951`) are left alone: they may come from a reference table.
 */
export function looksLikePrintedFloat(raw: string): boolean {
  const mantissa = raw.toLowerCase().split('e')[0]!.replace(/_/g, '');
  const [, decimals = ''] = mantissa.split('.');
  if (decimals.length < 12) return false;
  const significant = mantissa.replace(/[^\d]/g, '').replace(/^0+/, '');
  if (significant.length < 13) return false;
  return /[1-9]0{5,}[1-9]\d{0,2}$/.test(decimals) || /9{5,}\d{0,3}$/.test(decimals);
}

const TOLERANT = /^(toBeCloseTo|closeTo|approximately)$/;

/**
 * Expected values pasted from a run of the code. The only static signal precise enough to act on is a
 * float with rounding noise: a hand-derived value is `2.9`, not `2.9000000000000004`, so the noise means
 * someone ran the code and copied what it printed — and the test now pins today's arithmetic, bugs included.
 */
export const oracleCopiedFromOutput: Rule = {
  id: 'oracle-copied-from-output',
  severity: 'warning',
  description: 'Expected value carries floating-point rounding noise (`0.30000000000000004`) — it was copied from the code’s own output, not worked out independently.',
  fix: 'Derive the expected value by hand (or from the spec), write it the way a person would (`79.99`), and compare with `toBeCloseTo(79.99, 2)`. If the value comes from an external reference (e.g. NumPy), say so in a comment.',
  check(file) {
    const out: RawFinding[] = [];
    for (const t of eachTest(file)) {
      for (const a of t.assertions) {
        const s = a.subject;
        const expected = a.args[0];
        if (!s || !expected?.decimalLiterals || a.matcherKind !== 'equal' || a.negated || TOLERANT.test(a.matcher ?? '')) continue;
        // Asserting on a constant or the test's own literal is another rule's finding.
        if (s.kind === 'literal' || s.pureLiteral) continue;
        // A round trip (`parse('0.30000000000000004')`) gets the digits from its input, not from the output.
        const copied = expected.decimalLiterals.find((raw) => looksLikePrintedFloat(raw) && !s.text.includes(raw));
        if (!copied) continue;
        out.push(
          atAssertion(
            t,
            a,
            `Expected value ${code(copied, 30)} carries floating-point rounding noise — it was copied from the code's output, so the test pins whatever the code computes today, bugs included.`,
          ),
        );
      }
    }
    return out;
  },
};
