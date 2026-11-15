import type { Rule } from '../core/types.js';
import { assertsOnMock } from './asserts-on-mock.js';
import { assertsOnOwnLiteral } from './asserts-on-own-literal.js';
import { catchOnlyAssertion } from './catch-only-assertion.js';
import { conditionalAssertion } from './conditional-assertion.js';
import { excessiveMocking } from './excessive-mocking.js';
import { focusedTest } from './focused-test.js';
import { mockedUnitUnderTest } from './mocked-unit-under-test.js';
import { neverFailingAssertion } from './never-failing-assertion.js';
import { noAssertions } from './no-assertions.js';
import { oracleCopiedFromOutput } from './oracle-copied-from-output.js';
import { reimplementedAlgorithm } from './reimplemented-algorithm.js';
import { skippedTest } from './skipped-test.js';
import { snapshotOnly } from './snapshot-only.js';
import { swallowedAssertion } from './swallowed-assertion.js';
import { tautologicalAssertion } from './tautological-assertion.js';
import { weakCalledAssertion } from './weak-called-assertion.js';

export const rules: Rule[] = [
  noAssertions,
  tautologicalAssertion,
  assertsOnMock,
  assertsOnOwnLiteral,
  neverFailingAssertion,
  swallowedAssertion,
  catchOnlyAssertion,
  mockedUnitUnderTest,
  excessiveMocking,
  snapshotOnly,
  conditionalAssertion,
  reimplementedAlgorithm,
  oracleCopiedFromOutput,
  weakCalledAssertion,
  focusedTest,
  skippedTest,
];

export function ruleById(id: string): Rule | undefined {
  return rules.find((r) => r.id === id);
}
