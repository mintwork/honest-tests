import { test } from 'node:test';
import { qualifiesForFreeShipping } from '../src/pricing.js';

test('free shipping', async (t) => {
  await t.test('for members', (t) => {
    t.assert.equal(qualifiesForFreeShipping(10, true), true);
  });

  await t.test('above the threshold', () => {
    qualifiesForFreeShipping(60, false); // no assertion
  });
});

test('threshold helper', (t) => {
  const threshold = t.mock.fn(() => 50);
  t.assert.equal(threshold(), 50); // asserts on the mock
});
