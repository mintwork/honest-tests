// Mocha-style describe/it, run by node:test (`node --test` picks up test/**/*.js).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount } from '../src/pricing.js';

describe('applyDiscount', () => {
  it('takes the percentage off the amount', () => {
    assert.equal(applyDiscount(200, 25), 150);
  });

  it('accepts the 0% and 100% boundaries', () => {
    assert.equal(applyDiscount(200, 0), 200);
    assert.equal(applyDiscount(200, 100), 0);
  });

  it('rejects percentages outside 0..100', () => {
    assert.throws(() => applyDiscount(200, -1), RangeError);
    assert.throws(() => applyDiscount(200, 101), RangeError);
  });
});
