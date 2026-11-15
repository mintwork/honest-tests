import { expect, it } from 'vitest';
import { round } from '../src/stats';

it('rounds to two digits by default', () => {
  expect(round(1.23456)).toBe(1.23);
});

it('rounds to the requested number of digits', () => {
  expect(round(1.25, 1)).toBe(1.3);
});
