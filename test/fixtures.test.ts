import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { audit } from '../src/core/engine.js';

const ROOT = resolve(__dirname, '..');

describe('fixture: bad-project (AI-style tests)', () => {
  const result = audit({ paths: ['fixtures/bad-project'], cwd: ROOT });
  const byFile = (file: string) =>
    result.findings.filter((f) => f.file === `fixtures/bad-project/test/${file}`).map((f) => `${f.ruleId}@${f.line}`);

  it('finds every planted smell in pricing.test.ts', () => {
    expect(byFile('pricing.test.ts')).toEqual([
      'tautological-assertion@16',
      'never-failing-assertion@20',
      'no-assertions@25',
      'catch-only-assertion@33',
      'swallowed-assertion@39',
      'tautological-assertion@48',
      'asserts-on-mock@53',
      'conditional-assertion@59',
      'snapshot-only@63',
    ]);
  });

  it('catches the mocked unit and the type-only test in checkout.test.ts', () => {
    expect(byFile('checkout.test.ts')).toEqual(['mocked-unit-under-test@5', 'asserts-on-mock@10', 'asserts-on-own-literal@15']);
  });

  it('catches focus/skip and never-failing checks in misc.test.ts', () => {
    expect(byFile('misc.test.ts')).toEqual([
      'focused-test@7',
      'never-failing-assertion@9',
      'never-failing-assertion@14',
      'skipped-test@17',
    ]);
  });

  it('summarizes how many tests cannot fail', () => {
    expect(result.filesScanned).toBe(3);
    expect(result.testsScanned).toBe(15);
    expect(result.summary).toEqual({ error: 13, warning: 3, info: 0, suspiciousTests: 11 });
  });

  it('emits complete machine-readable findings', () => {
    const f = result.findings.find((x) => x.ruleId === 'swallowed-assertion')!;
    expect(f).toEqual({
      ruleId: 'swallowed-assertion',
      severity: 'error',
      file: 'fixtures/bad-project/test/pricing.test.ts',
      line: 39,
      column: 7,
      message: expect.stringContaining('try/catch'),
      evidence: 'expect(applyDiscount(100, 20)).toBe(70); // wrong! but the catch hides it',
      test: 'computes the discounted price',
      fix: expect.stringContaining('toThrow'),
    });
  });
});

describe('fixture: good-project (honest tests)', () => {
  it('has no findings', () => {
    const result = audit({ paths: ['fixtures/good-project'], cwd: ROOT });
    expect(result.findings).toEqual([]);
    expect(result.testsScanned).toBe(12);
  });
});

describe('discovery', () => {
  it('honors --ignore globs', () => {
    const result = audit({ paths: ['fixtures'], cwd: ROOT, ignore: ['fixtures/bad-project/**', '**/bad'] });
    expect(result.findings).toEqual([]);
    expect(result.filesScanned).toBe(3);
  });
});
