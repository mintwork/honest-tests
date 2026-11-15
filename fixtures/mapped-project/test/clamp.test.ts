import { expect, it } from 'vitest';
import { clamp } from '../src/stats';

it('raises values below the range to the minimum', () => {
  expect(clamp(-5, 0, 10)).toBe(0);
});

it('lowers values above the range to the maximum', () => {
  expect(clamp(15, 0, 10)).toBe(10);
});

it('keeps values inside the range, including both ends', () => {
  expect(clamp(0, 0, 10)).toBe(0);
  expect(clamp(7, 0, 10)).toBe(7);
  expect(clamp(10, 0, 10)).toBe(10);
});
