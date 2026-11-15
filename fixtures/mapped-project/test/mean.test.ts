import { expect, it } from 'vitest';
import { mean } from '../src/stats';

it('averages the values', () => {
  expect(mean([1, 2, 6])).toBe(3);
});

it('is 0 for no values', () => {
  expect(mean([])).toBe(0);
});
