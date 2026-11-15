import type { Assertion, RawFinding, Rule, TestCase } from '../core/types.js';
import { atAssertion, code, eachTest } from './helpers.js';

const WEAK = /^(toHaveBeenCalled|toBeCalled)$/;
const WITH = /^(toHaveBeenCalledWith|toHaveBeenLastCalledWith|toHaveBeenNthCalledWith|toBeCalledWith|lastCalledWith|nthCalledWith|toHaveBeenCalledExactlyOnceWith)$/;
const CALLS_READ = /^(.+?)\.mock\.(calls\[|lastCall\b)/;

/** `vi.mocked(fn)` / `jest.mocked(fn)` -> `fn`. */
function mockName(text: string): string {
  return text.replace(/^(?:vi|jest)\.mocked\((.+)\)$/, '$1');
}

/** `api.post` -> `api`: the binding a mock path hangs off. */
function rootOf(target: string): string {
  return target.split(/[.[(]/)[0]!;
}

/** True if the test declares the mock itself (`const spy = vi.fn()`): then it isn't the `spy` of any other test. */
function declaredIn(t: TestCase, target: string): boolean {
  return t.declaredNames?.includes(rootOf(target)) ?? false;
}

/** The mock whose arguments this assertion checks, if it checks any. */
function argumentCheckTarget(a: Assertion): string | null {
  if (!a.subject || a.negated) return null;
  if (WITH.test(a.matcher ?? '') && a.args.length > 0) return mockName(a.subject.text);
  const m = CALLS_READ.exec(a.subject.text);
  return m && a.matcherKind !== 'length' && a.matcherKind !== 'none' ? mockName(m[1]!) : null;
}

/**
 * `expect(save).toHaveBeenCalled()` passes whatever `save` was called with. It only fires when the file
 * proves the mock receives arguments worth checking — another test checks the arguments of the same
 * shared mock (`toHaveBeenCalledWith(...)`, `save.mock.calls[0][0]`) — and this test never checks them.
 * Mocks a test declares itself (`const onClose = vi.fn()`) are never matched by name against other
 * tests, and negated checks (`not.toHaveBeenCalled()`) are never flagged. A mock's implementation
 * having parameters is not used as evidence: field-testing showed those implementations usually assert
 * on the arguments themselves or ignore them.
 */
export const weakCalledAssertion: Rule = {
  id: 'weak-called-assertion',
  severity: 'info',
  description: '`toHaveBeenCalled()` with no arguments on a shared mock whose arguments other tests in the file check — wrong arguments would still pass.',
  fix: 'Assert the call itself: `expect(save).toHaveBeenCalledWith({ id: 1, total: 35 })` (use `expect.objectContaining` for the fields that matter).',
  check(file) {
    // Only mocks shared across tests (file-level, describe-level or imported) carry evidence between tests.
    const sharedWithArgs = new Set<string>();
    for (const t of file.tests) for (const a of t.assertions) {
      const target = argumentCheckTarget(a);
      if (target && !declaredIn(t, target)) sharedWithArgs.add(target);
    }
    const out: RawFinding[] = [];
    for (const t of eachTest(file)) {
      const checkedHere = new Set(t.assertions.map(argumentCheckTarget).filter((x): x is string => !!x));
      // A test whose only checks are "was called" verifies the least; otherwise this is a hint.
      const onlyCalledChecks = t.helperAssertionCalls === 0 && t.assertions.every((a) => a.matcherKind === 'called' && !WITH.test(a.matcher ?? ''));
      for (const a of t.assertions) {
        if (a.style !== 'expect' || !a.subject || a.negated || a.args.length > 0 || !WEAK.test(a.matcher ?? '')) continue;
        const target = mockName(a.subject.text);
        if (checkedHere.has(target)) continue;
        if (declaredIn(t, target) || !sharedWithArgs.has(target)) continue;
        out.push(
          atAssertion(t, a, `Only checks that ${code(target)} was called, not with what. Other tests in this file check its arguments, so a call with the wrong arguments would still pass here.`, {
            severity: onlyCalledChecks ? 'warning' : 'info',
          }),
        );
      }
    }
    return out;
  },
};
