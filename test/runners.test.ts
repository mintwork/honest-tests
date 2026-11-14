import { describe, expect, it } from 'vitest';
import { jsAdapter } from '../src/adapters/js/index.js';
import { parseJsTestFile } from '../src/adapters/js/parse-tests.js';
import { auditSource } from '../src/core/engine.js';

/** `rule@line` for an inline test file; line 1 is the first line of `src`. */
function hits(src: string, file = 'src/widget.test.ts'): string[] {
  return auditSource(file, src).map((f) => `${f.ruleId}@${f.line}`);
}

/** `name:kind:modifier` for every test/suite the parser found. */
function shape(src: string, file = 'src/widget.test.ts'): string[] {
  return parseJsTestFile(file, src).tests.map((t) => `${t.name}:${t.kind}:${t.modifier ?? '-'}`);
}

describe('mocha', () => {
  const HEAD = "const { expect } = require('chai');\nconst assert = require('assert');\n";

  it('understands describe/context/specify and chai expect/should/assert', () => {
    const src =
      HEAD +
      [
        `describe('cart', function () {`,
        `  context('empty', () => {`,
        `    specify('totals 0', () => { expect(total([])).to.equal(0); });`,
        `  });`,
        `  it('should style', function () { total([1]).should.equal(1); });`,
        `  it('assert style', function () { assert.strictEqual(total([2]), 2); });`,
        `  it('no assertion', function () { total([3]); });`,
        `  it('self compare', () => { const x = total([4]); expect(x).to.equal(x); });`,
        `});`,
      ].join('\n');
    expect(hits(src, 'test/cart.spec.js')).toEqual(['no-assertions@9', 'tautological-assertion@10']);
  });

  it('treats an unconditional this.skip() as a skip, but not a guarded one', () => {
    const src = [
      `it('later', function () { this.skip(); total([1]); });`,
      `it('needs db', function () { if (!db) this.skip(); expect(total([1])).to.equal(1); });`,
      `it('arrow this', () => { this.skip(); total([1]); });`,
    ].join('\n');
    expect(shape(src)).toEqual(['later:test:skip', 'needs db:test:-', 'arrow this:test:-']);
    expect(hits(src)).toEqual(['skipped-test@1', 'no-assertions@3']);
  });

  it('counts a done callback that the code calls back, not one called synchronously', () => {
    const src = [
      `it('emits', (done) => { bus.on('x', () => done()); bus.emit('x'); });`,
      `it('passes done on', function (done) { request(app).get('/').end(done); });`,
      `it('calls done itself', (done) => { total([1]); done(); });`,
      `it('done.fail is still a callback', (done) => { load().then(() => done(), done.fail); });`,
      `it('done inside an argument object', (done) => { router.handle(req, { end: done }); });`,
    ].join('\n');
    expect(hits(src)).toEqual(['no-assertions@3']);
  });

  it('does not treat it.each table parameters as callbacks', () => {
    expect(hits(`it.each([[1, 2]])('adds', (a, done) => {\n  add(a, done);\n});`)).toEqual(['no-assertions@1']);
  });

  it('flags .only', () => {
    expect(hits(`it.only('x', () => { expect(total([1])).to.equal(1); });`)).toEqual(['focused-test@1']);
  });
});

describe('node:test', () => {
  const HEAD = "import { test, describe, it, mock } from 'node:test';\nimport assert from 'node:assert/strict';\n";

  it('counts t.assert.* and node:assert as assertions', () => {
    const src = HEAD + [`test('a', (t) => { t.assert.equal(total([1]), 1); });`, `test('b', () => { assert.deepStrictEqual(total([1]), 1); });`].join('\n');
    expect(hits(src, 'test/a.test.mjs')).toEqual([]);
    const [a] = parseJsTestFile('a.test.mjs', src).tests;
    expect(a?.assertions[0]).toMatchObject({ style: 'assert', matcher: 'equal', matcherKind: 'equal', subject: { text: 'total([1])' } });
  });

  it('runs existing rules on t.assert: self-comparison, snapshot-only', () => {
    const src = HEAD + [`test('a', (t) => { const r = total([1]); t.assert.strictEqual(r, r); });`, `test('b', (t) => { t.assert.snapshot(total([1])); });`].join('\n');
    expect(hits(src)).toEqual(['tautological-assertion@3', 'snapshot-only@4']);
  });

  it('reads skip/todo/only from the options object and t.skip()/t.todo() in the body', () => {
    const src =
      HEAD +
      [
        `test('o1', { skip: true }, () => { total([1]); });`,
        `test('o2', { skip: 'flaky on CI' }, () => { total([1]); });`,
        `test('o3', { todo: true }, () => { total([1]); });`,
        `test('o4', { only: true }, () => { assert.ok(total([1])); });`,
        `test('o5', { skip: process.env.CI }, () => { assert.ok(total([1])); });`,
        `test('b1', (t) => { t.skip('later'); });`,
        `test('b2', (t) => { t.todo(); total([1]); });`,
        `describe.skip('suite', () => {});`,
      ].join('\n');
    expect(shape(src)).toEqual(['o1:test:skip', 'o2:test:skip', 'o3:test:todo', 'o4:test:only', 'o5:test:-', 'b1:test:skip', 'b2:test:todo', 'suite:suite:skip']);
  });

  it('treats t.test subtests as tests and a parent that only groups them as a suite', () => {
    const src =
      HEAD +
      [
        `test('group', async (t) => {`,
        `  await t.test('checked', () => { assert.equal(total([1]), 1); });`,
        `  await t.test('unchecked', () => { total([2]); });`,
        `});`,
        `test('mixed', async (t) => {`,
        `  assert.equal(total([]), 0);`,
        `  await t.test('inner', (t) => { t.assert.ok(total([3])); });`,
        `});`,
      ].join('\n');
    expect(shape(src)).toEqual(['group:suite:-', 'checked:test:-', 'unchecked:test:-', 'mixed:test:-', 'inner:test:-']);
    expect(hits(src)).toEqual(['no-assertions@5']);
    // the parent's assertions don't include the subtest's
    expect(parseJsTestFile('a.test.mjs', src).tests[3]?.assertions).toHaveLength(1);
  });

  it('understands tap/tspl-style context assertions (t.strictEqual, tspl(t), destructured)', () => {
    const src =
      `const { tspl } = require('@matteo.collina/tspl');\nconst { test } = require('node:test');\n` +
      [
        `test('a', (t) => { t = tspl(t, { plan: 1 }); t.strictEqual(total([1]), 1); });`,
        `test('b', (t) => { const p = tspl(t, { plan: 1 }); p.deepStrictEqual(total([1]), [1]); });`,
        `test('c', (t) => { const { strictEqual } = tspl(t, { plan: 1 }); strictEqual(total([1]), 1); });`,
        `test('d', (t) => { const p = tspl(t); const r = total([1]); p.equal(r, r); });`,
        `test('e', (t) => { t.after(() => close()); total([1]); });`,
      ].join('\n');
    expect(hits(src, 'test/a.js')).toEqual(['tautological-assertion@6', 'no-assertions@7']);
  });

  it("lets subtests use the parent's tspl object, and counts require('node:assert') inline", () => {
    const src =
      `const { tspl } = require('@matteo.collina/tspl');\nconst { test } = require('node:test');\n` +
      [
        `test('validations', async (t) => {`,
        `  const p = tspl(t, { plan: 1 });`,
        `  await t.test('path', () => { p.equal(validate(null), false); });`,
        `});`,
        `test('inline', () => { require('node:assert').strictEqual(total([1]), 1); });`,
        `test('handler', (t) => { ws.on('error', t.assert.fail); ws.onclose = t.assert.ok.bind(null, true); });`,
      ].join('\n');
    expect(hits(src, 'test/a.js')).toEqual([]);
  });

  it('accepts a constant reached-marker in a callback when an assertion count is planned, not otherwise', () => {
    const src =
      HEAD +
      [
        `test('a', (t, done) => { t.plan(1); bus.on('x', () => { t.assert.ok(true); done(); }); });`,
        `test('b', () => { bus.on('x', () => { assert.ok(true); }); });`,
        `test('c', (t) => { t.plan(1); t.assert.ok('always truthy'); });`,
        `test('d', (t) => { t.plan(1); try { parse('x'); } catch { t.assert.ok(true); } });`,
        `test('e', (t) => { t.plan(2); t.assert.equal(total([1]), 1); t.assert.ok(true); });`,
      ].join('\n');
    expect(hits(src)).toEqual(['tautological-assertion@4', 'tautological-assertion@5']);
  });

  it('does not call a catch that forwards the error to reject/done swallowing', () => {
    const src =
      HEAD +
      [
        `test('a', async () => {`,
        `  await new Promise((resolve, reject) => {`,
        `    client.request({}, (err) => {`,
        `      try { assert.ok(err); resolve(); } catch (e) { reject(e); }`,
        `    });`,
        `  });`,
        `});`,
        `test('b', () => {`,
        `  try { assert.equal(total([1]), 1); } catch (e) { console.log(e); }`,
        `});`,
        `test('c', async (t) => {`,
        `  try { t.assert.equal(res.status, 200); await res.text(); } catch (err) { t.assert.equal(err.name, 'TypeError'); }`,
        `  try { t.assert.equal(res.status, 200); } catch (err) { t.assert.ok(err instanceof TypeError); }`,
        `  try { t.assert.equal(res.status, 200); } catch (err) { saved = err; }`,
        `  try { t.assert.equal(res.status, 200); } catch (err) { t.assert.ok(err); }`,
        `});`,
        `test('d', async (t) => {`,
        `  try { await fetch('about:config'); t.assert.fail('should fail'); } catch (e) { t.assert.ok(e); }`,
        `});`,
      ].join('\n');
    // (the catch check at 14 is still skipped whenever nothing throws: catch-only-assertion's warning)
    expect(hits(src)).toEqual(['swallowed-assertion@11', 'catch-only-assertion@14', 'swallowed-assertion@17']);
  });

  it('reads assert.ok(0) / assert(false) as a deliberate fail(), not a never-failing assertion', () => {
    const src =
      HEAD +
      [
        `test('a', () => {`,
        `  try { new Client('bad'); assert.ok(0); } catch (err) { assert.ok(err instanceof TypeError); }`,
        `});`,
        `test('b', () => { try { parse('x'); assert(false); } catch (err) { assert.equal(err.code, 'E'); } });`,
        `test('c', () => { try { parse('x'); } catch (err) { assert.equal(err.code, 'E'); } });`,
      ].join('\n');
    expect(hits(src)).toEqual(['catch-only-assertion@7']);
  });

  it('takes the computed side as the subject when the expected literal comes first', () => {
    const src = HEAD + `test('a', async () => { assert.strictEqual('hello', await body.text()); });`;
    expect(hits(src)).toEqual([]);
    expect(parseJsTestFile('a.test.mjs', src).tests[0]?.assertions[0]).toMatchObject({ subject: { text: 'body.text()' }, args: [{ text: "'hello'" }] });
  });

  it('treats t.plan(n) as an assertion count guard', () => {
    expect(hits(HEAD + `test('a', (t) => { t.plan(1); emit(t); });`)).toEqual([]);
  });

  it('recognizes mock.fn / t.mock.fn / t.mock.method as mocks', () => {
    const src =
      HEAD +
      [
        `test('a', () => { const f = mock.fn(() => 1); assert.equal(f(), 1); });`,
        `test('b', (t) => { const f = t.mock.fn(() => 2); t.assert.equal(f(), 2); });`,
        `test('c', (t) => { t.mock.method(clock, 'now', () => 3); assert.equal(clock.now(), 3); });`,
        `test('d', (t) => { const f = t.mock.fn(); f.mock.mockImplementation(() => 4); assert.equal(f(), 4); });`,
        `test('e', (t) => { const f = t.mock.fn(); use(f); assert.equal(f.mock.callCount(), 1); });`,
        `test('f', (t) => {`,
        `  const f = t.mock.fn(() => 5);`,
        `  f.mock.restore();`,
        `  assert.equal(f(), undefined);`,
        `});`,
        `test('g', (t) => {`,
        `  const f = t.mock.fn(() => 6);`,
        `  t.mock.restoreAll();`,
        `  assert.equal(f(), undefined);`,
        `});`,
      ].join('\n');
    expect(hits(src)).toEqual(['asserts-on-mock@3', 'asserts-on-mock@4', 'asserts-on-mock@5', 'asserts-on-mock@6']);
  });

  it('flags mock.module of the unit under test', () => {
    const src = HEAD + `import { total } from './cart';\nmock.module('./cart', { namedExports: { total: () => 1 } });\ntest('a', () => { assert.equal(total(), 1); });`;
    expect(hits(src, 'src/cart.test.mjs')).toContain('mocked-unit-under-test@4');
  });
});

describe('bun:test', () => {
  const HEAD = "import { test, expect, mock, spyOn, describe } from 'bun:test';\n";

  it('recognizes mock() and spyOn() from bun:test as mock factories', () => {
    const src =
      HEAD +
      [
        `test('a', () => { const f = mock(() => 3); expect(f()).toBe(3); });`,
        `test('b', () => { spyOn(clock, 'now').mockReturnValue(4); expect(clock.now()).toBe(4); });`,
        `test('c', () => { const f = mock(); run(f); expect(f).toHaveBeenCalledWith(1); });`,
        `test('d', () => {`,
        `  const f = mock(() => 5);`,
        `  mock.restore();`,
        `  expect(f()).toBe(5);`,
        `});`,
      ].join('\n');
    expect(hits(src)).toEqual(['asserts-on-mock@2', 'asserts-on-mock@3']);
  });

  it('understands test.if / test.skipIf / test.todo / describe.if', () => {
    const src =
      HEAD +
      [
        `test.if(isMac)('mac only', () => { total([1]); });`,
        `test.skipIf(isWin)('not on windows', () => { expect(total([1])).toBe(1); });`,
        `test.todo('later');`,
        `describe.if(ok)('group', () => {});`,
      ].join('\n');
    expect(shape(src)).toEqual(['mac only:test:-', 'not on windows:test:-', 'later:test:todo', 'group:suite:-']);
    expect(hits(src)).toEqual(['no-assertions@2']);
  });

  it('flags mock.module of the unit under test', () => {
    const src = HEAD + `import { total } from './cart';\nmock.module('./cart', () => ({ total: () => 1 }));\ntest('a', () => { expect(total()).toBe(1); });`;
    expect(hits(src, 'src/cart.test.ts')).toContain('mocked-unit-under-test@3');
  });
});

describe('Deno', () => {
  const HEAD =
    "import { assert, assertEquals, assertExists, assertNotEquals, assertThrows } from 'jsr:@std/assert';\n" +
    "import { assertSnapshot } from 'jsr:@std/testing/snapshot';\n";

  it('finds Deno.test in every call shape', () => {
    const src =
      HEAD +
      [
        `Deno.test('plain', () => { assertEquals(total([1]), 1); });`,
        `Deno.test('with options', { permissions: { read: true } }, () => { assertEquals(total([1]), 1); });`,
        `Deno.test(function namedTest() { assertEquals(total([1]), 1); });`,
        `Deno.test({ name: 'object', fn() { assertEquals(total([1]), 1); } });`,
        `Deno.test({ name: 'object arrow', fn: () => { assertEquals(total([1]), 1); } });`,
        `Deno.test({ name: 'ignored', ignore: true, fn: () => { total([1]); } });`,
        `Deno.test({ name: 'focused', only: true, fn: () => { assert(total([1])); } });`,
        `Deno.test({ name: 'per-os', ignore: Deno.build.os === 'windows', fn: () => { assert(total([1])); } });`,
        `Deno.test.ignore('ignored 2', () => { total([1]); });`,
        `Deno.test.only('focused 2', () => { assert(total([1])); });`,
      ].join('\n');
    expect(shape(src, 'cart_test.ts')).toEqual([
      'plain:test:-',
      'with options:test:-',
      'namedTest:test:-',
      'object:test:-',
      'object arrow:test:-',
      'ignored:test:skip',
      'focused:test:only',
      'per-os:test:-',
      'ignored 2:test:skip',
      'focused 2:test:only',
    ]);
    expect(hits(src, 'cart_test.ts')).toEqual(['skipped-test@8', 'focused-test@9', 'skipped-test@11', 'focused-test@12']);
  });

  it('maps @std/assert functions onto the rules', () => {
    const src =
      HEAD +
      [
        `Deno.test('self', () => { const r = total([1]); assertEquals(r, r); });`,
        `Deno.test('constant', () => { assert(true); });`,
        `Deno.test('always defined', () => { assertExists({}); });`,
        `Deno.test('none', () => { total([1]); });`,
        `Deno.test('negated assertion', () => { assertNotEquals(total([1]), 2); });`,
        `Deno.test('throws', () => { assertThrows(() => total(null)); });`,
      ].join('\n');
    expect(hits(src, 'cart_test.ts')).toEqual(['tautological-assertion@3', 'tautological-assertion@4', 'never-failing-assertion@5', 'no-assertions@6']);
    const t = parseJsTestFile('cart_test.ts', src).tests[4]!;
    expect(t.assertions[0]).toMatchObject({ matcher: 'assertNotEquals', matcherKind: 'equal', negated: true });
  });

  it('reads assertSnapshot(t, value) as a snapshot of value', () => {
    const src = HEAD + `Deno.test('snap', async (t) => { await assertSnapshot(t, total([1])); });`;
    expect(hits(src, 'cart_test.ts')).toEqual(['snapshot-only@3']);
    expect(parseJsTestFile('cart_test.ts', src).tests[0]?.assertions[0]?.subject?.text).toBe('total([1])');
  });

  it('treats t.step as a subtest', () => {
    const src =
      HEAD +
      [
        `Deno.test('steps', async (t) => {`,
        `  await t.step('one', () => { assertEquals(total([1]), 1); });`,
        `  await t.step({ name: 'two', fn: () => { total([2]); } });`,
        `});`,
      ].join('\n');
    expect(shape(src, 'cart_test.ts')).toEqual(['steps:suite:-', 'one:test:-', 'two:test:-']);
    expect(hits(src, 'cart_test.ts')).toEqual(['no-assertions@5']);
  });

  it('accepts @std/assert from deno.land URLs, npm: and sub-paths', () => {
    for (const spec of ['https://deno.land/std@0.224.0/assert/mod.ts', 'https://deno.land/std/testing/asserts.ts', '@std/assert', 'npm:@std/assert', 'jsr:@std/assert@1/equals']) {
      const src = `import { assertEquals } from '${spec}';\nDeno.test('a', () => { const r = f(); assertEquals(r, r); });`;
      expect(hits(src, 'a_test.ts')).toEqual(['tautological-assertion@2']);
    }
  });

  it('does not treat an unrelated `Deno.test`-like member as a test', () => {
    expect(shape(`Foo.test('x', () => {});\nDeno.bench('b', () => {});`, 'a_test.ts')).toEqual([]);
  });
});

describe('test file discovery', () => {
  it('knows Deno/Bun *_test names and node:test test-* names', () => {
    expect(jsAdapter.isTestFile('/r/src/cart_test.ts')).toBe(true);
    expect(jsAdapter.isCandidateTestFile!('/r/src/test-cart.mjs')).toBe(true);
  });

  it('treats files under test/ as candidates, but not fixtures, helpers or type declarations', () => {
    expect(jsAdapter.isCandidateTestFile!('/r/test/cart.js')).toBe(true);
    expect(jsAdapter.isCandidateTestFile!('/r/tests/unit/cart.ts')).toBe(true);
    expect(jsAdapter.isCandidateTestFile!('/r/test/fixtures/broken.js')).toBe(false);
    expect(jsAdapter.isCandidateTestFile!('/r/test/helpers/db.js')).toBe(false);
    expect(jsAdapter.isCandidateTestFile!('/r/test/types.d.ts')).toBe(false);
    expect(jsAdapter.isCandidateTestFile!('/r/src/cart.js')).toBe(false);
    // already a test file by name: not a mere candidate
    expect(jsAdapter.isCandidateTestFile!('/r/test/cart.test.js')).toBe(false);
  });
});
