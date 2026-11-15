import { describe, expect, it } from 'vitest';
import { rules } from '../src/rules/index.js';
import { looksLikePrintedFloat } from '../src/rules/oracle-copied-from-output.js';
import { auditSource } from '../src/core/engine.js';
import { HEADER, hits, scan } from './support.js';

describe('no-assertions', () => {
  it('flags a test that only calls the code', () => {
    expect(hits(`it('adds', () => {\n  add(1, 2);\n});`)).toEqual(['no-assertions@2']);
  });

  it('accepts expect, assert, helper assertions and supertest-style .expect()', () => {
    const src = [
      `it('a', () => { expect(add(1, 2)).toBe(3); });`,
      `it('b', () => { assert.equal(add(1, 2), 3); });`,
      `it('c', () => { expectValidUser(makeUser()); });`,
      `it('d', async () => { await request(app).get('/').expect(200); });`,
      `it('e', () => { expect.hasAssertions(); run(); });`,
    ].join('\n');
    expect(hits(src)).toEqual([]);
  });

  it('ignores todo and skipped tests (skips are reported separately)', () => {
    expect(hits(`it.todo('later');\nit.skip('off', () => { add(1, 2); });`)).toEqual(['skipped-test@3']);
  });

  it('understands it.each tables', () => {
    expect(hits(`it.each([[1, 2]])('adds %i', (a, b) => {\n  add(a, b);\n});`)).toEqual(['no-assertions@2']);
  });
});

describe('tautological-assertion', () => {
  it('flags comparing a value with itself', () => {
    expect(hits(`it('x', () => {\n  const r = add(1, 2);\n  expect(r).toBe(r);\n});`)).toEqual(['tautological-assertion@4']);
  });

  it('flags recomputing the same call as the expected value', () => {
    expect(hits(`it('x', () => {\n  expect(format(5)).toEqual(format(5));\n});`)).toEqual(['tautological-assertion@3']);
  });

  it('flags asserting on a constant', () => {
    expect(hits(`it('x', () => {\n  expect(true).toBe(true);\n  assert(1);\n});`)).toEqual(['tautological-assertion@3', 'tautological-assertion@4']);
  });

  it('flags an expected value derived from the actual value', () => {
    expect(hits(`it('x', () => {\n  const list = build();\n  expect(list).toHaveLength(list.length);\n});`)).toEqual([
      'tautological-assertion@4',
    ]);
  });

  it('leaves matcher-less constants to never-failing-assertion', () => {
    expect(hits(`it('x', () => {\n  expect(true).toBeTruthy;\n});`)).toEqual(['never-failing-assertion@3']);
  });

  it('only treats equality/length matchers on identifiers and members as derived', () => {
    const src = [
      `it('x', () => {`,
      `  expect(price).toBeGreaterThan(price.floor);`,
      `  expect(load()).toBe(load().cached);`,
      `});`,
    ].join('\n');
    expect(hits(src)).toEqual([]);
  });

  it('does not flag a real comparison', () => {
    expect(hits(`it('x', () => {\n  expect(add(1, 2)).toBe(3);\n  expect(user.name).toEqual(expected.name);\n});`)).toEqual([]);
  });
});

describe('asserts-on-own-literal', () => {
  it('flags asserting on a field of a literal the test just built', () => {
    expect(hits(`it('x', () => {\n  const p = { service: 's3' };\n  expect(p.service).toBe('s3');\n});`)).toEqual(['asserts-on-own-literal@4']);
  });

  it('names the literal and where it was built', () => {
    const [f] = scan(`it('x', () => {\n  const p = { service: 's3' };\n  expect(p.service).toBe('s3');\n});`);
    expect(f?.severity).toBe('error');
    expect(f?.message).toContain('`p.service`');
    expect(f?.message).toContain('literal `p` built on line 3');
  });

  it('sees through type annotations, `as`/`satisfies`, nesting, arrays, spreads and shorthand', () => {
    const src = [
      `it('type test', () => {`,
      `  const base: Base = { region: 'eu' } as const;`,
      `  const id = 'a';`,
      `  const p = { ...base, id, items: [{ name: 'x' }], tags: ['t', ...['u']] } satisfies Props;`,
      `  expect(p.items[0].name).toBe('x');`,
      `  expect(p.tags).toHaveLength(2);`,
      `  expect(p.region.length).toBe(2);`,
      `  expect(p.id).not.toBe('b');`,
      `  expect(p.tags).toContain('u');`,
      `  expect(p).toEqual({ region: 'eu', id: 'a', items: [{ name: 'x' }], tags: ['t', 'u'] });`,
      `  assert.equal(p.region, 'eu');`,
      `  assert(p.region === 'eu');`,
      `});`,
    ].join('\n');
    expect(hits(src)).toEqual([6, 7, 8, 9, 10, 11, 12, 13].map((l) => `asserts-on-own-literal@${l}`));
  });

  it('accepts a literal that is passed to the code under test (it may be mutated)', () => {
    const src = [
      `it('a', () => { const input = { a: 1 }; normalize(input); expect(input.a).toBe(2); });`,
      `it('b', () => { const a = { x: 1 }; const b = { a }; run(b); expect(a.x).toBe(2); });`,
      `it('c', () => { const p = { n: 1 }; const r = inc(p); expect(p.n).toBe(1); expect(r).toBe(2); });`,
      `it('d', () => { const p = { items: [] }; p.items.push(3); expect(p.items).toHaveLength(1); });`,
      `it('e', () => { const p = { a: 1 }; p.a = compute(); expect(p.a).toBe(2); });`,
      `it('f', () => { let p = { a: 1 }; p = load(); expect(p.a).toBe(2); });`,
      `it('g', () => { const p = { a: 1 }; delete p.a; expect(p).toEqual({}); });`,
      `it('h', () => { const p = { a: 1 }; [1].forEach(() => use(p.a)); expect(p.a).toBe(1); });`,
      `it('i', () => { const p = { a: 1 }; Object.assign(p, defaults()); expect(p.a).toBe(1); });`,
    ].join('\n');
    expect(hits(src)).toEqual([]);
  });

  it('accepts values that involve calls, imports, outer bindings or parameters', () => {
    const src = [
      `import { DEFAULT } from './config';`,
      `const shared = { a: 1 };`,
      `it('a', () => { const p = { id: makeId() }; expect(p.id).toBe('1'); });`,
      `it('b', () => { const p = { s: DEFAULT }; expect(p.s).toBe('s3'); });`,
      `it('c', () => { expect(shared.a).toBe(1); });`,
      `it.each([[1]])('d', (n) => { const p = { n }; expect(p.n).toBe(1); });`,
      `it('e', () => { const p = { s: 's3' }; expect(p.s).toBe(DEFAULT); });`,
      `it('f', () => { const p = { xs: [1] }; expect(p.xs.map((x) => x * 2)).toEqual([2]); });`,
      `it('g', () => { const p = { get x() { return calc(); } }; expect(p.x).toBe(1); });`,
      `it('h', () => { const p = new Point({ x: 1 }); expect(p.x).toBe(1); });`,
      `it('i', () => { const p = { [key()]: 1 }; expect(p.a).toBe(1); });`,
      `it('j', () => { const p = { a: \`\${now()}\` }; expect(p.a).toBe('1'); });`,
      `it('k', () => { const p = { a: 1 }; expect(p).toBeInstanceOf(Shape); });`,
    ].join('\n');
    expect(hits(src)).toEqual([]);
  });

  it('accepts reads that can reach the prototype (prototype-pollution tests)', () => {
    const src = [
      `it('x', () => {`,
      `  const obj = {};`,
      `  const arr = [];`,
      `  const p = { a: 1, ...obj };`,
      `  expect(obj.polluted).toBe(undefined);`,
      `  expect(arr.polluted).toBeUndefined();`,
      `  expect(p.polluted).toBeUndefined();`,
      `  expect(p.a.toFixed).toBeDefined();`,
      `  expect('polluted' in obj).toBe(false);`,
      `  expect(obj).not.toHaveProperty('polluted');`,
      `  expect(arr[0]).toBeUndefined();`,
      `  applyPatches({}, [{ op: 'add', path: ['__proto__', 'polluted'], value: 'yes' }]);`,
      `});`,
    ].join('\n');
    expect(hits(src)).toEqual([]);
  });

  it('follows own properties through spreads, computed keys and indexes', () => {
    const src = [
      `it('x', () => {`,
      `  const k = 'b';`,
      `  const base = { a: 1, b: 2 };`,
      `  const p = { ...base, a: 3, [k]: 4, list: ['x', 'y'] };`,
      `  expect(p.a).toBe(3);`,
      `  expect(p.b).toBe(4);`,
      `  expect(p[k]).toBe(4);`,
      `  expect(p.list[1]).toBe('y');`,
      `  expect(p.list[1].length).toBe(1);`,
      `  expect(p['list'][0]).toBe('x');`,
      `});`,
    ].join('\n');
    expect(hits(src)).toEqual([6, 7, 8, 9, 10, 11].map((l) => `asserts-on-own-literal@${l}`));
  });

  it('resolves quoted and numeric keys, string indexes, later spreads and literal-to-literal comparisons', () => {
    const src = [
      `import { equal } from 'node:assert';`,
      `it('x', () => {`,
      `  const base = { x: 1 };`,
      `  const p = { 'a-b': 1, 2: 'two', a: 1, ...base };`,
      `  const q = { a: 1 };`,
      `  const s = 'ab';`,
      `  expect(p['a-b']).toBe(1);`,
      `  expect(p[2]).toBe('two');`,
      `  expect(p.a).toBe(1);`,
      `  expect(s[0]).toBe('a');`,
      `  expect(p).toEqual(q);`,
      `  equal(q.a, 1);`,
      `});`,
    ].join('\n');
    expect(hits(src)).toEqual([8, 9, 10, 11, 12, 13].map((l) => `asserts-on-own-literal@${l}`));
  });

  it('names the literal binding, not a same-named property', () => {
    const [f] = scan(`it('x', () => {\n  const a = 1;\n  const p = { a: 2, b: a };\n  expect(p.a).toBe(2);\n});`);
    expect(f?.message).toContain('literal `p` built on line 4');
  });

  it('accepts reads of prototype members on strings and arrays, and missing nested properties', () => {
    const src = [
      `it('x', () => {`,
      `  const p = { a: 'x', list: [1] };`,
      `  expect(p.a.foo).toBeUndefined();`,
      `  expect(p.list.foo).toBeUndefined();`,
      `  expect(p.missing.deep).toBeUndefined();`,
      `});`,
    ].join('\n');
    expect(hits(src)).toEqual([]);
  });

  it('accepts operators and templates that mix a literal with outside values', () => {
    const src = [
      `it('x', () => {`,
      `  const p = { a: 1 };`,
      `  expect(p.a + offset).toBe(2);`,
      `  expect(p.a || fallback()).toBe(1);`,
      `  expect(flag ? p.a : 2).toBe(1);`,
      `  expect(\`\${p.a}\${suffix}\`).toBe('1x');`,
      `  expect(!ready && p.a).toBe(1);`,
      `});`,
    ].join('\n');
    expect(hits(src)).toEqual([]);
  });

  it('ignores same-named properties, object keys and type positions when looking for other uses', () => {
    const src = [
      `it('x', () => {`,
      `  const p = { a: 1 };`,
      `  run(other.p, { p: 1 });`,
      `  type T = typeof p;`,
      `  expect(p.a).toBe(1);`,
      `});`,
    ].join('\n');
    expect(hits(src)).toEqual(['asserts-on-own-literal@6']);
  });

  it('treats catch parameters, destructured names and function declarations as rebinding the name', () => {
    const src = [
      `it('a', () => { const p = { a: 1 }; try { run(); } catch (p) { log(p); } expect(p.a).toBe(1); });`,
      `it('b', () => { const p = { a: 1 }; run(({ p }) => p); expect(p.a).toBe(1); });`,
      `it('c', () => { const p = { a: 1 }; run(() => { const [p2, ...[p]] = load(); }); expect(p.a).toBe(1); });`,
      `it('d', () => { const p = { a: 1 }; run(() => { function p() {} }); expect(p.a).toBe(1); });`,
      `it('e', () => { let p; p = { a: 1 }; expect(p.a).toBe(1); });`,
    ].join('\n');
    expect(hits(src).filter((h) => h.startsWith('asserts-on-own-literal'))).toEqual([]);
  });

  it('accepts a name bound more than once in the test (shadowing is not followed)', () => {
    const src = `it('x', () => {\n  const p = { a: 1 };\n  expect(p.a).toBe(1);\n  run((p) => p);\n});`;
    expect(hits(src)).toEqual([]);
  });

  it('leaves matchers that fail on plain values, snapshots and inline literals to other rules', () => {
    const src = [
      `it('a', () => { const p = { a: 1 }; expect(p).toThrow(); });`,
      `it('b', () => { const p = { a: 1 }; expect(p).toHaveBeenCalled(); });`,
      `it('c', () => { const p = { a: 1 }; expect(p).toMatchSnapshot(); });`,
      `it('d', () => { const p = { a: 1 }; expect(p).toEqual(p); });`,
      `it('e', () => { expect({ a: 1 }).toEqual({ a: 1 }); });`,
      `it('f', () => { const msg = 'Invalid value'; render(); expect(msg).toHaveBeenWarnedTimes(1); });`,
      `it('g', () => { const p = { a: 1 }; expect(p).toSatisfyAll(check); });`,
    ].join('\n');
    expect(hits(src).filter((h) => h.startsWith('asserts-on-own-literal'))).toEqual([]);
  });
});

describe('asserts-on-mock', () => {
  it('flags asserting on the value a vi.fn was told to return', () => {
    const src = `it('x', () => {\n  const getUser = vi.fn().mockReturnValue({ id: 1 });\n  expect(getUser()).toEqual({ id: 1 });\n});`;
    expect(hits(src)).toEqual(['asserts-on-mock@4']);
  });

  it('follows a result alias and mockResolvedValue', () => {
    const src = `it('x', async () => {\n  fetchUser.mockResolvedValue(u);\n  const r = await fetchUser(1);\n  expect(r).toBe(u);\n});`;
    expect(hits(src)).toEqual(['asserts-on-mock@5']);
  });

  it('flags spyOn targets and vi.mocked()', () => {
    const src = [
      `it('x', () => {`,
      `  vi.spyOn(api, 'get').mockReturnValue(5);`,
      `  expect(api.get()).toBe(5);`,
      `});`,
      `it('y', () => {`,
      `  vi.mocked(load).mockReturnValue(1);`,
      `  expect(load()).toBe(1);`,
      `});`,
    ].join('\n');
    expect(hits(src)).toEqual(['asserts-on-mock@4', 'asserts-on-mock@8']);
  });

  it('flags asserting on mock.results', () => {
    const src = `it('x', () => {\n  const getUser = vi.fn(() => u);\n  getUser();\n  expect(getUser.mock.results[0].value).toBe(u);\n});`;
    expect(hits(src)).toEqual(['asserts-on-mock@5']);
  });

  it('does not flag the real unit, its results, or unconfigured mocks', () => {
    const src = [
      `it('x', () => {`,
      `  const getUser = vi.fn().mockReturnValue({ name: 'Ada' });`,
      `  const log = vi.fn();`,
      `  const svc = new Greeter(getUser, log);`,
      `  const greeting = svc.greet(1);`,
      `  expect(svc.greet(1)).toBe('Hello, Ada');`,
      `  expect(greeting).toBe('Hello, Ada');`,
      `  expect(svc.lastGreeted).toBe(1);`,
      `  expect(log()).toBeUndefined();`,
      `  expect(getUser).toHaveBeenCalledWith(1);`,
      `});`,
    ].join('\n');
    expect(hits(src)).toEqual([]);
  });

  it('allows interaction assertions and testing the real unit with a mocked dependency', () => {
    const src = [
      `it('x', async () => {`,
      `  const repo = { find: vi.fn().mockResolvedValue({ name: 'Ada' }) };`,
      `  const svc = new UserService(repo);`,
      `  expect(await svc.greet(1)).toBe('Hello, Ada');`,
      `  expect(repo.find).toHaveBeenCalledWith(1);`,
      `});`,
    ].join('\n');
    expect(hits(src)).toEqual([]);
  });
});

describe('mocked-unit-under-test', () => {
  it('flags mocking the module the test file is named after', () => {
    const src = `import { total } from '../src/cart';\nvi.mock('../src/cart');\nit('x', () => { expect(total([])).toBe(0); });`;
    expect(hits(src, 'test/cart.test.ts')).toEqual(['mocked-unit-under-test@3']);
  });

  it('downgrades partial mocks to a warning', () => {
    const src = `import { total } from './cart';\nvi.mock('./cart', async (importOriginal) => ({ ...(await importOriginal()), tax: vi.fn() }));\nit('x', () => { expect(total([])).toBe(0); });`;
    const [f] = scan(src, 'src/cart.spec.ts');
    expect(f?.ruleId).toBe('mocked-unit-under-test');
    expect(f?.severity).toBe('warning');
  });

  it('flags spying on and replacing an export of the unit', () => {
    const src = `import * as cart from '../src/cart';\nit('x', () => {\n  vi.spyOn(cart, 'total').mockReturnValue(3);\n  expect(cart.total([])).toBe(3);\n});`;
    expect(hits(src, 'test/cart.test.ts')).toEqual(['mocked-unit-under-test@4', 'asserts-on-mock@5']);
  });

  it('allows mocking dependencies', () => {
    const src = `import { total } from '../src/cart';\nvi.mock('../src/tax');\nvi.mock('node:fs');\nit('x', () => { expect(total([])).toBe(0); });`;
    expect(hits(src, 'test/cart.test.ts')).toEqual([]);
  });
});

describe('excessive-mocking', () => {
  it('warns when five or more modules are mocked', () => {
    const mocks = ['a', 'b', 'c', 'd', 'e'].map((m) => `vi.mock('./${m}');`).join('\n');
    expect(hits(`${mocks}\nit('x', () => { expect(run()).toBe(1); });`)).toEqual(['excessive-mocking@2']);
  });

  it('is quiet below the threshold', () => {
    const mocks = ['a', 'b', 'c', 'd'].map((m) => `vi.mock('./${m}');`).join('\n');
    expect(hits(`${mocks}\nit('x', () => { expect(run()).toBe(1); });`)).toEqual([]);
  });
});

describe('snapshot-only', () => {
  it('flags tests whose only assertion is a snapshot', () => {
    expect(hits(`it('renders', () => {\n  expect(render()).toMatchSnapshot();\n});`)).toEqual(['snapshot-only@2']);
  });

  it('allows a snapshot alongside a real assertion', () => {
    expect(hits(`it('renders', () => {\n  const html = render();\n  expect(html).toContain('Total: $35');\n  expect(html).toMatchSnapshot();\n});`)).toEqual(
      [],
    );
  });
});

describe('swallowed-assertion', () => {
  it('flags assertions inside a try whose catch swallows', () => {
    expect(hits(`it('x', () => {\n  try {\n    expect(f()).toBe(1);\n  } catch (e) {\n    console.log(e);\n  }\n});`)).toEqual([
      'swallowed-assertion@4',
    ]);
  });

  it('allows a catch that rethrows, and try/finally', () => {
    const src = [
      `it('x', () => {`,
      `  try { expect(f()).toBe(1); } catch (e) { cleanup(); throw e; }`,
      `});`,
      `it('y', () => {`,
      `  try { expect(f()).toBe(1); } finally { cleanup(); }`,
      `});`,
    ].join('\n');
    expect(hits(src)).toEqual([]);
  });
});

describe('catch-only-assertion', () => {
  it('flags assertions that only run if the code throws', () => {
    expect(hits(`it('x', () => {\n  try {\n    parse('');\n  } catch (e) {\n    expect(e.message).toBe('empty');\n  }\n});`)).toEqual([
      'catch-only-assertion@6',
    ]);
  });

  it('accepts expect.assertions, a fail() in the try, or toThrow', () => {
    const src = [
      `it('a', () => {`,
      `  expect.assertions(1);`,
      `  try { parse(''); } catch (e) { expect(e.message).toBe('empty'); }`,
      `});`,
      `it('b', () => {`,
      `  try { parse(''); expect.fail('should throw'); } catch (e) { expect(e.message).toBe('empty'); }`,
      `});`,
      `it('c', () => {`,
      `  expect(() => parse('')).toThrow('empty');`,
      `});`,
    ].join('\n');
    expect(hits(src)).toEqual([]);
  });
});

describe('never-failing-assertion', () => {
  it('flags a matcher that is never called', () => {
    expect(hits(`it('x', () => {\n  expect(load()).toBeTruthy;\n});`)).toEqual(['never-failing-assertion@3']);
  });

  it('flags a bare expect()', () => {
    expect(hits(`it('x', () => {\n  expect(load());\n});`)).toEqual(['never-failing-assertion@3']);
  });

  it('flags always-true checks', () => {
    const src = [
      `it('x', () => {`,
      `  expect(typeof value).toBeDefined();`,
      `  expect({ a: 1 }).toBeTruthy();`,
      `  expect(items.length).toBeGreaterThanOrEqual(0);`,
      `  expect(new Cart()).toBeDefined();`,
      `});`,
    ].join('\n');
    expect(hits(src)).toEqual(['never-failing-assertion@3', 'never-failing-assertion@4', 'never-failing-assertion@5', 'never-failing-assertion@6']);
  });

  it('flags un-awaited async matchers but not awaited or returned ones', () => {
    const src = [
      `it('x', () => {`,
      `  expect(load()).resolves.toBe(1);`,
      `});`,
      `it('y', async () => {`,
      `  await expect(load()).resolves.toBe(1);`,
      `});`,
      `it('z', () => {`,
      `  return expect(load()).rejects.toThrow('nope');`,
      `});`,
      `it('w', () => expect(load()).resolves.toBe(1));`,
    ].join('\n');
    expect(hits(src)).toEqual(['never-failing-assertion@3']);
  });

  it('does not flag negated or meaningful checks', () => {
    const src = [
      `it('x', () => {`,
      `  expect(typeof value).not.toBeDefined();`,
      `  expect(items.length).toBeGreaterThan(0);`,
      `  expect(items.length).toBeGreaterThanOrEqual(1);`,
      `  expect(total).toBeGreaterThanOrEqual(0);`,
      `  expect(items.length).toBeLessThanOrEqual(-1);`,
      `  expect(user).toBeTruthy();`,
      `});`,
    ].join('\n');
    expect(hits(src)).toEqual([]);
  });

  it('flags length > negative number', () => {
    expect(hits(`it('x', () => {\n  expect(list.size).toBeGreaterThan(-1);\n});`)).toEqual(['never-failing-assertion@3']);
  });

  it('accepts chai-style property assertions', () => {
    expect(hits(`it('x', () => {\n  expect(isValid('a')).to.be.true;\n});`)).toEqual([]);
  });
});

describe('conditional-assertion', () => {
  it('flags assertions behind an if', () => {
    expect(hits(`it('x', () => {\n  const r = find();\n  if (r) {\n    expect(r.id).toBe(1);\n  }\n});`)).toEqual(['conditional-assertion@5']);
  });

  it('flags assertions behind &&', () => {
    expect(hits(`it('x', () => {\n  const r = find();\n  r && expect(r.id).toBe(1);\n});`)).toEqual(['conditional-assertion@4']);
  });
});

describe('focused-test / skipped-test', () => {
  it('flags .only, fit and fdescribe as errors', () => {
    const src = `it.only('a', () => { expect(f()).toBe(1); });\nfit('b', () => { expect(f()).toBe(1); });\nfdescribe('s', () => {});`;
    const found = scan(src);
    expect(found.map((f) => `${f.ruleId}@${f.line}`)).toEqual(['focused-test@2', 'focused-test@3', 'focused-test@4']);
    expect(new Set(found.map((f) => f.severity))).toEqual(new Set(['error']));
  });

  it('flags .skip, xit and xdescribe as warnings, but not skipIf', () => {
    const src = `it.skip('a', () => {});\nxit('b', () => {});\nxdescribe('s', () => {});\nit.skipIf(isWindows)('c', () => { expect(f()).toBe(1); });`;
    const found = scan(src);
    expect(found.map((f) => `${f.ruleId}@${f.line}`)).toEqual(['skipped-test@2', 'skipped-test@3', 'skipped-test@4']);
    expect(new Set(found.map((f) => f.severity))).toEqual(new Set(['warning']));
  });
});

describe('suppression comments', () => {
  it('honors disable-next-line, disable-line and file-level disable', () => {
    const src = [
      `it('a', () => {`,
      `  // honest-tests-disable-next-line tautological-assertion`,
      `  expect(true).toBe(true);`,
      `  expect(true).toBe(true); // honest-tests-disable-line`,
      `});`,
      `it('b', () => {`,
      `  expect(1).toBe(1);`,
      `});`,
    ].join('\n');
    expect(hits(src)).toEqual(['tautological-assertion@8']);
    expect(hits(`/* honest-tests-disable tautological-assertion */\n${src}`)).toEqual([]);
  });

  it('only suppresses the listed rule', () => {
    const src = `// honest-tests-disable-next-line snapshot-only\nit('a', () => { run(); });`;
    expect(hits(src)).toEqual(['no-assertions@3']);
  });
});

describe('reimplemented-algorithm', () => {
  it('flags an expected value recomputed from the call inputs', () => {
    const src = [
      `it('a', () => {`,
      `  expect(total(price, qty)).toBe(price * qty * (1 + TAX));`,
      `  const r = total(price, qty);`,
      `  expect(r).toBe(price * qty * 1.2);`,
      `  assert.equal(area(w, h), w * h);`,
      `  expect(offset(page)).toBe((page.number - 1) * page.size);`,
      `  expect(dist(a, b)).toBe(Math.sqrt(a.x ** 2 + b.y ** 2));`,
      `  expect(add(x, 1)).toBe(x + 1);`,
      `});`,
    ].join('\n');
    expect(hits(src)).toEqual([3, 5, 6, 7, 8, 9].map((l) => `reimplemented-algorithm@${l}`));
    const [f] = scan(src);
    expect(f?.severity).toBe('warning');
    expect(f?.message).toContain("recomputes `total`'s result from its own inputs (`price`, `qty`)");
  });

  it('leaves hand-derived values, relationships, strings and other calls alone', () => {
    const src = [
      `it('a', () => {`,
      `  expect(total(10, 3)).toBe(10 * 3 * 1.2);`,
      `  expect(after.length).toBe(before.length + 1);`,
      `  expect(add(a, b)).toBe(a + b);`,
      `  expect(greet(name)).toBe('Hi ' + name);`,
      `  expect(scale(x)).toBe(other * 2);`,
      `  expect(total(cart)).toBe(subtotal(cart) + tax(cart));`,
      `  expect(double(x)).not.toBe(x * 3);`,
      `  expect(Math.max(a, b)).toBe(a * 1);`,
      `  expect(sum(xs)).toBeGreaterThan(xs * 2);`,
      `  const r = x;`,
      `  expect(r).toBe(x * 2);`,
      `  expect(now()).toBe(start + 1000);`,
      `  expect(f(x)).toBe(x);`,
      `  expect(clamp(x, 5)).toBe(Math.min(x, 5));`,
      `});`,
    ].join('\n');
    expect(hits(src)).toEqual([]);
  });
});

describe('oracle-copied-from-output', () => {
  it('flags expected floats that carry rounding noise', () => {
    const src = [
      `it('a', () => {`,
      `  expect(quantile(arr, 0.5)).toEqual([2.9000000000000004, 3.2]);`,
      `  expect(total(items)).toBe(79.98999999999999);`,
      `  assert.strictEqual(sum(xs), 0.30000000000000004);`,
      `  const r = mean(xs);`,
      `  expect(r).toBe(3.2499999999999996);`,
      `});`,
    ].join('\n');
    expect(hits(src)).toEqual([3, 4, 5, 7].map((l) => `oracle-copied-from-output@${l}`));
    const [f] = scan(src);
    expect(f?.severity).toBe('warning');
    expect(f?.message).toContain('`2.9000000000000004` carries floating-point rounding noise');
  });

  it('leaves tolerant matchers, reference values, round trips and constants alone', () => {
    const src = [
      `it('a', () => {`,
      `  expect(sum(xs)).toBeCloseTo(0.30000000000000004);`,
      `  expect(distance(a, b)).toBe(14.142135623730951);`,
      `  expect(0.1 + 0.2).toBe(0.30000000000000004);`,
      `  expect(parse('0.30000000000000004')).toBe(0.30000000000000004);`,
      `  expect(f()).toBe(1.500000000000);`,
      `  expect(f()).not.toBe(0.30000000000000004);`,
      `  expect(tiny()).toBe(0.000000000001234);`,
      `  expect(f()).toBe(79.99);`,
      `});`,
    ].join('\n');
    expect(hits(src)).toEqual([]);
  });

  it('recognizes the printed-float shape', () => {
    expect(['0.30000000000000004', '79.98999999999999', '3.2499999999999996', '1.1000000000000001e-7', '1.300000000004'].map(looksLikePrintedFloat)).toEqual([
      true, true, true, true, true,
    ]);
    // 11 decimals; 9 significant digits; no noise; padded zeros; tiny hand-typed; integer
    expect(
      ['12345.30000000004', '0.0000000300000004', '14.142135623730951', '0.6666666666666666', '1.500000000000', '0.000000000001234', '12'].map(looksLikePrintedFloat),
    ).toEqual([false, false, false, false, false, false, false]);
  });
});

describe('weak-called-assertion', () => {
  const shared = (b: string) =>
    [
      `const save = vi.fn();`,
      `it('saves the order', () => {`,
      `  submit(order, save);`,
      `  expect(save).toHaveBeenCalledWith({ id: 1 });`,
      `});`,
      `it('saves again', () => {`,
      b,
      `});`,
    ].join('\n');

  it('flags a bare toHaveBeenCalled on a shared mock whose arguments another test checks', () => {
    expect(hits(shared(`  submit(other, save);\n  expect(save).toHaveBeenCalled();`))).toEqual(['weak-called-assertion@9']);
    const [only] = scan(shared(`  submit(other, save);\n  expect(save).toBeCalled();`));
    expect(only?.severity).toBe('warning');
    expect(only?.message).toContain('Only checks that `save` was called, not with what');
    const [hint] = scan(shared(`  expect(submit(other, save)).toBe(true);\n  expect(save).toHaveBeenCalled();`));
    expect(hint?.severity).toBe('info');
  });

  it('accepts vi.mocked(...) and mock.calls reads as evidence', () => {
    const src = [
      `it('a', () => { load(); expect(vi.mocked(api.get)).toHaveBeenCalledWith('/x'); });`,
      `it('b', () => { load(); expect(api.get).toHaveBeenCalled(); });`,
      `it('c', () => { load(); expect(store.put.mock.calls[0][0]).toEqual({ a: 1 }); });`,
      `it('d', () => { load(); expect(vi.mocked(store.put)).toHaveBeenCalled(); });`,
    ].join('\n');
    expect(hits(src)).toEqual(['weak-called-assertion@3', 'weak-called-assertion@5']);
  });

  it('does not flag local mocks, negations, argument checks or mocks without argument evidence', () => {
    const src = [
      `it('a', () => { const spy = vi.fn(); run(spy); expect(spy).toHaveBeenCalledWith(1); });`,
      `it('b', () => { const spy = vi.fn(); run(spy); expect(spy).toHaveBeenCalled(); });`,
      `it('c', () => { run(); expect(api.get).toHaveBeenCalledWith('/x'); });`,
      `it('d', () => { run(); expect(api.get).not.toHaveBeenCalled(); });`,
      `it('e', () => { run(); expect(api.get).toHaveBeenCalled(); expect(api.get.mock.calls[0][0]).toBe('/x'); });`,
      `it('f', () => { run(); expect(api.get).toHaveBeenCalledTimes(1); });`,
      `it('g', () => { run(); expect(onClose).toHaveBeenCalled(); });`,
      `it('h', () => { run(); expect(log).toHaveBeenCalledWith(); expect(log.mock.calls.length).toBe(1); });`,
      `it('i', () => { run(); expect(log).toHaveBeenCalled(); });`,
      `it('j', (spy) => { run(spy); expect(spy).toHaveBeenCalled(); });`,
      `it('k', () => { run(); expect(api.get).toHaveBeenCalledOnce(); });`,
      `it('l', () => { run(); expect(db.put).not.toHaveBeenCalledWith(1); });`,
      `it('m', () => { run(); expect(db.put).toHaveBeenCalled(); });`,
      // a save declared inside test n says nothing about the shared save in test o
      `it('n', () => { const save = vi.fn(); run(save); expect(save).toHaveBeenCalledWith(1); });`,
      `it('o', () => { run(); expect(save).toHaveBeenCalled(); });`,
    ].join('\n');
    expect(hits(src)).toEqual([]);
  });
});

describe('rule catalog', () => {
  it('has unique kebab-case ids with descriptions and fixes', () => {
    const ids = rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of rules) {
      expect(r.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(r.description.length).toBeGreaterThan(20);
      expect(r.fix.length).toBeGreaterThan(20);
    }
  });
});

// Regressions from field-testing on real projects. Each snippet is a minimal synthetic version of a
// pattern that produced a false positive (or a crash) in a real codebase.
describe('field-test regressions', () => {
  describe('no-assertions', () => {
    it('counts functions imported from node:assert / assert / chai (node:test style)', () => {
      const src = [
        `import { equal, ok as truthy } from 'node:assert';`,
        `import * as a from 'assert/strict';`,
        `const { match } = require('node:assert');`,
        `const strict = require('node:assert').strict;`,
        `it('a', () => { equal(add(1, 2), 3); });`,
        `it('b', () => { truthy(isReady()); });`,
        `it('c', () => { a.deepEqual(list(), [1]); });`,
        `it('d', () => { match(version(), /^\\d/); });`,
        `it('e', () => { strict.equal(add(1, 1), 2); });`,
      ].join('\n');
      expect(hits(src)).toEqual([]);
    });

    it('still flags a test that only calls an imported non-assert function', () => {
      expect(hits(`import { equal } from './math';\nit('a', () => {\n  equal(1, 2);\n});`)).toEqual(['no-assertions@3']);
    });

    it('counts calls to file-local helpers that assert, including helpers calling helpers', () => {
      const src = [
        `function checkHeader(headers, key, value) { expect(headers[key]).toBe(value); }`,
        `const differential = (schema, inputs) => { for (const i of inputs) checkHeader(run(schema, i), 'x', 1); };`,
        `function setup() { return build(); }`,
        `it('a', () => { checkHeader(req().headers, 'Content-Type', 'json'); });`,
        `it('b', () => { differential(schema, [1, 2]); });`,
        `it('c', () => {\n  setup();\n});`,
      ].join('\n');
      expect(hits(src)).toEqual(['no-assertions@7']);
    });

    it('recognizes vitest browser-mode expect.element()', () => {
      expect(hits(`it('a', async () => {\n  await expect.element(page.getByText('Hi')).toBeVisible();\n});`)).toEqual([]);
    });
  });

  describe('focused-test / test discovery', () => {
    it('does not treat a local function named fit() inside a test as a focused test', () => {
      const src = [
        `it('truncates', async () => {`,
        `  const { fit } = await import('./text');`,
        `  expect(fit('a b c', 3)).toBe('a b');`,
        `});`,
        `function context() { return {}; }`,
        `context('not a suite', () => {});`,
      ].join('\n');
      const found = scan(src);
      expect(found).toEqual([]);
    });

    it('does not count calls to a local `test` variable inside a test body as tests', () => {
      const src = `it('matches kinds', () => {\n  const test = kindOf('number');\n  expect(test(1)).toBe(true);\n});`;
      expect(hits(src)).toEqual([]);
      expect(auditSource('src/kind.test.ts', HEADER + src)).toEqual([]);
    });

    it('still reports jasmine fit() when it is not a local name', () => {
      expect(hits(`fit('b', () => { expect(f()).toBe(1); });`)).toEqual(['focused-test@2']);
    });

    it('keeps test template names readable', () => {
      const src = 'for (const mode of ["a"]) {\n  it(`checks ${mode} imports`, () => {\n    run();\n  });\n}';
      expect(scan(src)[0]?.test).toBe('`checks ${mode} imports`');
    });
  });

  describe('asserts-on-mock', () => {
    it('does not flag .mock.calls / .lastCall / .invocationCallOrder — those are interactions', () => {
      const src = [
        `it('x', async () => {`,
        `  const customFetch = vi.fn().mockResolvedValue(ok);`,
        `  await client({ fetch: customFetch }).get('/a');`,
        `  expect(customFetch.mock.calls[0][0]).toBe('/a');`,
        `  expect(customFetch.mock.calls.length).toBe(1);`,
        `  expect(customFetch.mock.lastCall).toEqual(['/a']);`,
        `  expect(customFetch.mock.invocationCallOrder[0]).toBeLessThan(2);`,
        `});`,
      ].join('\n');
      expect(hits(src)).toEqual([]);
    });

    it('stops treating a spy as configured after mockRestore()/restoreAllMocks()', () => {
      const src = [
        `it('x', () => {`,
        `  const spy = vi.spyOn(schema, 'parse').mockReturnValue(1);`,
        `  expect(schema.parse('a')).toBe(1);`,
        `  spy.mockRestore();`,
        `  expect(schema.parse('a')).toBe('a');`,
        `  vi.mocked(load).mockReturnValue(2);`,
        `  vi.restoreAllMocks();`,
        `  expect(load()).toBe(3);`,
        `});`,
      ].join('\n');
      expect(hits(src)).toEqual(['asserts-on-mock@4']);
    });
  });

  describe('tautological-assertion', () => {
    it('allows property checks against a transformed copy (sorted, lower-cased)', () => {
      const src = [
        `it('x', () => {`,
        `  const keys = Object.keys(mimeTypes);`,
        `  expect(keys).toEqual(keys.toSorted());`,
        `  expect(keys).toEqual(keys.map((k) => k.toLowerCase()));`,
        `});`,
      ].join('\n');
      expect(hits(src)).toEqual([]);
    });

    it('still flags restating the actual value as a copy', () => {
      const src = `it('x', () => {\n  const list = build();\n  expect(list).toEqual(list.slice());\n  expect(list).toEqual([...list]);\n});`;
      expect(hits(src)).toEqual(['tautological-assertion@4', 'tautological-assertion@5']);
    });
  });

  describe('never-failing-assertion', () => {
    it('does not call an expect.poll() callback "always truthy"', () => {
      expect(hits(`it('x', async () => {\n  await expect.poll(async () => (await status()).code).toBeTruthy();\n});`)).toEqual([]);
    });

    it('accepts an async matcher stored in a variable and awaited later', () => {
      const src = [
        `it('x', async () => {`,
        `  const pending = expect(check()).rejects.toThrow('late');`,
        `  await vi.advanceTimersByTimeAsync(1000);`,
        `  await pending;`,
        `});`,
        `it('y', async () => {`,
        `  const forgotten = expect(check()).rejects.toThrow('late');`,
        `});`,
      ].join('\n');
      expect(hits(src)).toEqual(['never-failing-assertion@8']);
    });
  });

  describe('catch-only-assertion', () => {
    it('accepts a catch that returns, followed by fail() after the try', () => {
      const src = `it('x', async () => {\n  try {\n    await get('/bad');\n  } catch (e) {\n    expect(e.message).toBe('bad');\n    return;\n  }\n  assert.fail('expected an error');\n});`;
      expect(hits(src)).toEqual([]);
    });

    it('accepts a catch that sets a flag asserted afterwards', () => {
      const src = `it('x', async () => {\n  let threw = false;\n  try {\n    await get('/bad');\n  } catch (e) {\n    threw = true;\n    expect(e.status).toBe(401);\n  }\n  expect(threw).toBe(true);\n});`;
      expect(hits(src)).toEqual([]);
    });

    it('still flags a catch-only test when the flag is never checked', () => {
      const src = `it('x', async () => {\n  let threw = false;\n  try {\n    await get('/bad');\n  } catch (e) {\n    threw = true;\n    expect(e.status).toBe(401);\n  }\n});`;
      expect(hits(src)).toEqual(['catch-only-assertion@8']);
    });
  });

  describe('conditional-assertion', () => {
    it('allows if/else (and else-if chains) where every branch asserts', () => {
      const src = [
        `it('x', async () => {`,
        `  if (kind === 'cancel') {`,
        `    await expect(p).rejects.toMatchObject({ code: 'ERR_CANCELED' });`,
        `  } else if (kind === 'error') {`,
        `    await expect(p).rejects.toThrow();`,
        `  } else {`,
        `    expect((await p).status).toBe(200);`,
        `  }`,
        `  kind ? expect(a).toBe(1) : expect(b).toBe(2);`,
        `});`,
      ].join('\n');
      expect(hits(src)).toEqual([]);
    });

    it('still flags an else-if chain with a branch that asserts nothing', () => {
      const src = `it('x', () => {\n  if (a) {\n    expect(f()).toBe(1);\n  } else if (b) {\n    run();\n  } else {\n    expect(f()).toBe(2);\n  }\n});`;
      expect(hits(src)).toEqual(['conditional-assertion@4']);
    });

    it('allows type-narrowing guards whose condition was already asserted', () => {
      const src = [
        `it('x', () => {`,
        `  const r = schema.safeParse(1);`,
        `  expect(r.success).toBe(false);`,
        `  if (!r.success) {`,
        `    expect(r.error.issues[0].message).toBe('bad');`,
        `  }`,
        `  expect(Array.isArray(body)).toBe(true);`,
        `  if (Array.isArray(body)) expect(body.length).toBe(2);`,
        `  expect(issue.code).toBe('invalid_type');`,
        `  if (issue.code === 'invalid_type') expect(issue.expected).toBe('string');`,
        `});`,
      ].join('\n');
      expect(hits(src)).toEqual([]);
    });

    it('allows a narrowing guard nested inside another excused guard', () => {
      const src = [
        `it('x', () => {`,
        `  const r = schema.safeParse('a');`,
        `  expect(r.success).toBe(false);`,
        `  if (!r.success) {`,
        `    const issue = r.error.issues[0];`,
        `    expect(issue.code).toBe('invalid_type');`,
        `    if (issue.code === 'invalid_type') expect(issue.expected).toBe('Test');`,
        `  }`,
        `});`,
      ].join('\n');
      expect(hits(src)).toEqual([]);
    });

    it('still flags a guard that was never asserted, and `expect() && expect()`', () => {
      const src = [
        `it('x', () => {`,
        `  const r = schema.safeParse(1);`,
        `  if (!r.success) {`,
        `    expect(r.error.issues[0].message).toBe('bad');`,
        `  }`,
        `});`,
        `it('y', () => {`,
        `  expect(input).toHaveValue('a') && expect(onRun).not.toHaveBeenCalled();`,
        `});`,
      ].join('\n');
      expect(hits(src)).toEqual(['conditional-assertion@5', 'conditional-assertion@9']);
    });
  });

  describe('mocked-unit-under-test', () => {
    it('treats a factory that calls its importOriginal parameter (any name) as a partial mock', () => {
      const src = `import { total } from './cart';\nvi.mock('./cart', async (orig) => ({ ...(await orig()), tax: vi.fn() }));\nit('x', () => { expect(total([])).toBe(0); });`;
      const [f] = scan(src, 'src/cart.spec.ts');
      expect(f?.severity).toBe('warning');
    });
  });

  describe('excessive-mocking', () => {
    it('counts each mocked module once even when re-mocked per test', () => {
      const mocks = [`vi.mock('./a');`, `vi.mock('./b');`, `vi.mock('./c');`, `it('x', () => { vi.doMock('./d'); expect(run()).toBe(1); });`, `it('y', () => { vi.doMock('./d'); expect(run()).toBe(2); });`];
      expect(hits(mocks.join('\n'))).toEqual([]);
    });
  });
});
