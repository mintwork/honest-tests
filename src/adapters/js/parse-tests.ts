import type * as t from '@babel/types';
import { basename } from 'node:path';
import type {
  Assertion,
  AssertionContext,
  ExprInfo,
  MatcherKind,
  MockRestore,
  MockSetup,
  ModuleMock,
  SpyOnUnit,
  TestCase,
  TestFileModel,
  TestModifier,
} from '../../core/types.js';
import {
  chainProps,
  chainRoot,
  describeExpr,
  isCall,
  isFunction,
  isMember,
  normText,
  parseSource,
  propName,
  rootNames,
  stringValue,
  textOf,
  unwrap,
  walk,
  type Node,
} from './ast.js';

const TEST_BASES = new Set(['it', 'test', 'specify', 'xit', 'fit', 'xtest']);
const SUITE_BASES = new Set(['describe', 'context', 'suite', 'xdescribe', 'fdescribe', 'xcontext']);
const TEST_MEMBER_MODS = new Set([
  'only',
  'skip',
  'todo',
  'each',
  'concurrent',
  'sequential',
  'fails',
  'failing',
  'skipIf',
  'runIf',
  'for',
  'shuffle',
  // bun:test
  'if',
  'todoIf',
  'serial',
  // Deno.test.ignore
  'ignore',
]);
/** Curried forms: `it.each(table)(name, fn)`, `test.skipIf(c)(name, fn)`, bun's `test.if(c)(name, fn)`. */
const CURRIED_MODS = new Set(['each', 'skipIf', 'runIf', 'for', 'if', 'todoIf']);
const CHAI_WORDS = new Set([
  'to',
  'be',
  'been',
  'is',
  'that',
  'which',
  'and',
  'has',
  'have',
  'with',
  'at',
  'of',
  'same',
  'but',
  'does',
  'still',
  'also',
  'deep',
  'nested',
  'own',
  'ordered',
  'any',
  'all',
  'should',
]);
const MODIFIER_WORDS = new Set(['not', 'resolves', 'rejects', ...CHAI_WORDS]);
const MOCK_CONFIG = /^(mockReturnValue|mockReturnValueOnce|mockResolvedValue|mockResolvedValueOnce|mockRejectedValue|mockRejectedValueOnce|mockImplementation|mockImplementationOnce|mockReturnThis)$/;
const MODULE_MOCK_FNS = new Set(['mock', 'doMock', 'unstable_mockModule']);
const HELPER_ASSERT = /^(expect|assert|verify|check|ensure|should|validate)([A-Z_]|$)/;
const FAIL_CALLS = new Set(['fail', 'expect.fail', 'assert.fail', 'chai.assert.fail']);
/** Test-context fail calls: `t.fail()`, `t.assert.fail()` (node:test), `p.fail()` (tspl), `done.fail()`. */
const CTX_FAIL = /^[\w$]+(\.assert)?\.fail$/;
/** Modules whose exports are assertion functions: `import { equal } from 'node:assert'`. */
const ASSERT_MODULES =
  /^((node:)?assert(\/strict)?|chai|uvu\/assert|power-assert|tap|tape|((jsr:|npm:)?@std\/(assert|testing\/(asserts|snapshot))(@[^/]+)?(\/[\w.-]+)*)|https?:\/\/deno\.land\/(x\/)?std(@[^/]+)?\/(assert|testing)\/[\w./-]+)$/;
/** Modules whose `mock` / `spyOn` exports create mocks (`import { mock, spyOn } from 'bun:test'`). */
const MOCK_MODULES = /^(bun:test|node:test)$/;
/** `expect.<x>(...)` entry points that start a matcher chain like `expect(...)` does. */
const EXPECT_ENTRY_PROPS = new Set(['soft', 'poll', 'element']);
/** Jasmine-style globals that are often also ordinary local names (`fit()` a text, `context`). */
const SHADOWABLE_TEST_BASES = new Set(['fit', 'xit', 'xtest', 'fdescribe', 'xdescribe', 'context', 'xcontext', 'specify', 'suite']);
/** Calls that undo a mock's configured behavior. */
const MOCK_RESTORE = /^(mockRestore|mockReset)$/;

const MATCHER_KINDS: Array<[RegExp, MatcherKind]> = [
  [/^(toMatchSnapshot|toMatchInlineSnapshot|toMatchFileSnapshot|toThrowErrorMatchingSnapshot|toThrowErrorMatchingInlineSnapshot|matchSnapshot|snapshot|fileSnapshot|assertSnapshot|assertInlineSnapshot)$/, 'snapshot'],
  // Deno @std/assert
  [/^(assertEquals|assertStrictEquals|assertNotEquals|assertNotStrictEquals|assertAlmostEquals|assertObjectMatch)$/, 'equal'],
  [/^assertFalse$/, 'falsy'],
  [/^assertExists$/, 'defined'],
  [/^(assertThrows|assertRejects|assertIsError)$/, 'throws'],
  [/^(assertInstanceOf|assertNotInstanceOf)$/, 'type'],
  [/^assertGreaterOrEqual$/, 'compare-gte'],
  [/^(assertGreater|assertLess|assertLessOrEqual)$/, 'compare-other'],
  [/^(toBe|toEqual|toStrictEqual|toMatchObject|equal|equals|eq|eql|strictEqual|deepEqual|deepStrictEqual|notEqual|notStrictEqual|notDeepEqual|notDeepStrictEqual|toBeCloseTo|closeTo|sameMembers|members|true|false)$/, 'equal'],
  [/^(toBeTruthy|ok|isOk|isTrue|assert|truthy)$/, 'truthy'],
  [/^(toBeFalsy|notOk|isNotOk|isFalse|falsy)$/, 'falsy'],
  // tap / ava / tspl context assertions
  [/^(same|notSame|strictSame|strictNotSame|is|not)$/, 'equal'],
  [/^(toBeDefined|exist|exists|isDefined|isNotUndefined)$/, 'defined'],
  [/^(toBeUndefined|undefined|isUndefined)$/, 'undefined'],
  [/^(toBeNull|null|isNull)$/, 'null'],
  [/^(toHaveLength|lengthOf|length|toHaveSize)$/, 'length'],
  [/^(toBeGreaterThanOrEqual|gte|least|isAtLeast)$/, 'compare-gte'],
  [/^(toBeGreaterThan|toBeLessThan|toBeLessThanOrEqual|gt|lt|lte|above|below|most|isAbove|isBelow|isAtMost)$/, 'compare-other'],
  [/^(toThrow|toThrowError|throw|throws|Throw|rejects|doesNotThrow)$/, 'throws'],
  [/^(toHaveBeenCalled|toHaveBeenCalledTimes|toHaveBeenCalledWith|toHaveBeenLastCalledWith|toHaveBeenNthCalledWith|toBeCalled|toBeCalledWith|toBeCalledTimes|toHaveReturned|toHaveReturnedWith|toHaveReturnedTimes|toHaveBeenCalledOnce|calledWith|called|calledOnce)$/, 'called'],
  [/^(toBeInstanceOf|toBeTypeOf|instanceOf|instanceof|a|an|typeOf|isString|isNumber|isArray|isObject|isFunction)$/, 'type'],
];

export function matcherKindOf(name: string | null): MatcherKind {
  if (!name) return 'none';
  for (const [re, kind] of MATCHER_KINDS) if (re.test(name)) return kind;
  return 'other';
}

interface TestCallInfo {
  base: string;
  kind: 'test' | 'suite';
  modifier: TestModifier;
  /** The node carrying the test name (a string, an options object's `name`, or a named function). */
  nameNode: Node | undefined;
  /** The test body, if it is an inline function (or a Deno `{ fn() {} }` method). */
  fn: Node | undefined;
  /** `it.each(table)` / `test.for(cases)`: parameters are table data, not callbacks. */
  parameterized?: boolean;
}

/** `{ skip: true }`, `{ only: true }`, `{ todo: 'reason' }`, Deno's `{ ignore: true }`: options known before the test runs. */
function optionModifier(options: Node | undefined): TestModifier {
  if (!options || options.type !== 'ObjectExpression') return null;
  const flag = (key: string) =>
    options.properties.some((p) => {
      if (p.type !== 'ObjectProperty' || p.computed) return false;
      const k = p.key.type === 'Identifier' ? p.key.name : stringValue(p.key as Node);
      if (k !== key) return false;
      const v = unwrap(p.value as Node);
      return (v.type === 'BooleanLiteral' && v.value) || (stringValue(v) ?? '') !== '';
    });
  if (flag('only')) return 'only';
  if (flag('todo')) return 'todo';
  if (flag('skip') || flag('ignore')) return 'skip';
  return null;
}

/** A property of an options object: `{ name: 'x' }` -> the `'x'` node; `{ fn() {} }` -> the method. */
function optionProp(options: Node, key: string): Node | undefined {
  if (options.type !== 'ObjectExpression') return undefined;
  for (const p of options.properties) {
    if ((p.type !== 'ObjectProperty' && p.type !== 'ObjectMethod') || p.computed) continue;
    const k = p.key.type === 'Identifier' ? p.key.name : stringValue(p.key as Node);
    if (k !== key) continue;
    return p.type === 'ObjectMethod' ? p : (p.value as Node);
  }
  return undefined;
}

function isTestFn(n: Node | undefined): boolean {
  return !!n && (isFunction(n) || n.type === 'ObjectMethod');
}

/**
 * Name, body and options of a test call's arguments, in every shape the runners accept:
 * `(name, fn)`, `(name, options, fn)` (node:test, vitest, Deno), `(fn)` with a named function and
 * `({ name, fn, ignore, only })` (Deno), `(name, fn, timeout)` (jest).
 */
function testCallArgs(args: Node[], objectForm: boolean): { nameNode: Node | undefined; fn: Node | undefined; options: Node | undefined } {
  const [first] = args;
  if (objectForm && first?.type === 'ObjectExpression') {
    const fn = optionProp(first, 'fn');
    return { nameNode: optionProp(first, 'name') ?? (fn && isFunction(fn) && fn.type === 'FunctionExpression' ? (fn.id ?? undefined) : undefined), fn: isTestFn(fn) ? fn : undefined, options: first };
  }
  if (first && isFunction(first)) {
    return { nameNode: first.type === 'FunctionExpression' ? (first.id ?? undefined) : undefined, fn: first, options: args.slice(1).find((a) => a.type === 'ObjectExpression') };
  }
  return { nameNode: first, fn: args.slice(1).find((a) => isFunction(a)), options: args.slice(1).find((a) => a.type === 'ObjectExpression') };
}

function resolveTestCall(call: t.CallExpression, localNames?: Set<string>): TestCallInfo | null {
  const mods: string[] = [];
  let curried = false;
  let deno = false;
  let cur: Node = call.callee as Node;
  for (;;) {
    if (cur.type === 'Identifier') break;
    if (isMember(cur)) {
      const name = propName(cur);
      // Deno.test(...) / Deno.test.only(...) / Deno.test.ignore(...)
      if (name === 'test' && cur.object.type === 'Identifier' && cur.object.name === 'Deno') {
        deno = true;
        break;
      }
      if (!name || !TEST_MEMBER_MODS.has(name)) return null;
      mods.unshift(name);
      cur = cur.object;
      continue;
    }
    if (isCall(cur) && !curried) {
      // it.each(table)(name, fn) / test.skipIf(cond)(name, fn)
      curried = true;
      cur = cur.callee as Node;
      continue;
    }
    return null;
  }
  const base = deno ? 'test' : (cur as t.Identifier).name;
  const isTest = TEST_BASES.has(base);
  const isSuite = SUITE_BASES.has(base);
  if (!isTest && !isSuite) return null;
  if (!deno && localNames?.has(base) && SHADOWABLE_TEST_BASES.has(base)) return null;
  if (curried && !mods.some((m) => CURRIED_MODS.has(m))) return null;
  // The inner `it.each(table)` / `test.skipIf(cond)` of a curried call is not a test itself.
  if (!curried && mods.some((m) => CURRIED_MODS.has(m))) return null;
  if (deno && (curried || mods.some((m) => m !== 'only' && m !== 'ignore'))) return null;
  if (!deno && mods.includes('ignore')) return null;

  const { nameNode, fn, options } = testCallArgs(call.arguments as Node[], deno);
  let modifier: TestModifier = optionModifier(options);
  if (base.startsWith('x') || mods.includes('skip') || mods.includes('ignore')) modifier = 'skip';
  if (base.startsWith('f') && base !== 'fails') modifier = 'only';
  if (mods.includes('only')) modifier = 'only';
  if (mods.includes('todo')) modifier = 'todo';
  return { base, kind: isTest ? 'test' : 'suite', modifier, nameNode, fn, parameterized: mods.includes('each') || mods.includes('for') };
}

/**
 * node:test subtests `t.test(name, [options], fn)` and Deno steps `t.step(name, fn)` / `t.step({ name, fn })`,
 * where `t` is the context parameter of an enclosing test.
 */
function resolveSubtestCall(call: t.CallExpression, contextNames: Set<string>): TestCallInfo | null {
  const callee = call.callee as Node;
  if (!isMember(callee) || callee.object.type !== 'Identifier' || !contextNames.has(callee.object.name)) return null;
  const name = propName(callee);
  if (name !== 'test' && name !== 'step') return null;
  const { nameNode, fn, options } = testCallArgs(call.arguments as Node[], name === 'step');
  if (!fn) return null;
  return { base: name, kind: 'test', modifier: optionModifier(options), nameNode, fn };
}

/** Name of a test function's first parameter: node:test/Deno's context `t`, or mocha/jest's `done`. */
function firstParamName(fn: Node | undefined): string | null {
  if (!fn || !('params' in fn)) return null;
  const p = (fn as t.Function).params[0];
  return p && p.type === 'Identifier' ? p.name : null;
}

function lineText(lines: string[], start: number, end: number): string {
  const slice = lines.slice(start - 1, Math.min(end, start + 2));
  return slice.map((l) => l.trim()).join(' ').slice(0, 200);
}

/** Expected unit-under-test name for a test file: `pricing.test.ts` -> `pricing`. */
export function unitNameForTestFile(path: string): string {
  let name = basename(path).replace(/\.(m|c)?[jt]sx?$/, '');
  name = name.replace(/[._-](test|spec|unit|int|integration)$/i, '');
  name = name.replace(/\.(test|spec)$/i, '');
  // node:test's `test-pricing.js`
  name = name.replace(/^test-(?=.)/i, '');
  return name.toLowerCase();
}

function specifierUnitName(spec: string): string {
  const parts = spec.split('/').filter(Boolean);
  let last = parts[parts.length - 1] ?? '';
  last = last.replace(/\.(m|c)?[jt]sx?$/, '');
  if (last === 'index' && parts.length > 1) last = parts[parts.length - 2]!;
  return last.toLowerCase();
}

function isLocalSpecifier(spec: string): boolean {
  return /^(\.{1,2}\/|\/|@\/|~\/?|#|src\/)/.test(spec);
}

interface MockScan {
  setups: MockSetup[];
}

/** Mock factories beyond `vi`/`jest`: bun:test's `mock()` / `spyOn()`, node:test's `mock` tracker. */
export interface MockVocab {
  /** Callable factories: `mock(impl)` from bun:test. */
  mockFns: Set<string>;
  /** `spyOn(obj, 'm')` from bun:test. */
  spyFns: Set<string>;
  /** Mock trackers with `.fn()` / `.method()` / `.module()` / `.restoreAll()`: node:test's `mock`, bun's `mock`. */
  mockObjects: Set<string>;
}

const EMPTY_MOCKS: MockVocab = { mockFns: new Set(), spyFns: new Set(), mockObjects: new Set() };

/** `mock` / `X.mock` (node:test's `t.mock`, `test.mock`): a tracker that creates and restores mocks. */
function isMockTracker(node: Node, mv: MockVocab): boolean {
  if (node.type === 'Identifier') return mv.mockObjects.has(node.name);
  return isMember(node) && propName(node) === 'mock' && node.object.type === 'Identifier';
}

interface MockFactory {
  kind: 'fn' | 'spyOn' | 'method';
  /** The call that creates the mock (innermost call of the chain). */
  call: t.CallExpression;
  configures: boolean;
}

/**
 * `vi.fn(impl)`, `jest.spyOn(o, 'm').mockReturnValue(1)`, bun's `mock(impl)` / `spyOn(o, 'm')`, node:test's
 * `mock.fn(impl)` / `t.mock.method(o, 'm', impl)`.
 */
function mockFactory(init: Node, mv: MockVocab): MockFactory | null {
  if (!isCall(init)) return null;
  const root = chainRoot(init);
  if (root.type !== 'Identifier') return null;
  const props = chainProps(init);
  const call = innermostCall(init);
  const configured = props.some((p) => MOCK_CONFIG.test(p));
  let kind: MockFactory['kind'] | null = null;
  if (root.name === 'vi' || root.name === 'jest') {
    if (props[0] === 'fn' || props[0] === 'spyOn') kind = props[0];
  } else if (call.callee === root) {
    kind = mv.mockFns.has(root.name) ? 'fn' : mv.spyFns.has(root.name) ? 'spyOn' : null;
  } else if (isMember(call.callee as Node) && isMockTracker((call.callee as t.MemberExpression).object, mv)) {
    const n = propName(call.callee as t.MemberExpression);
    if (n === 'fn' || n === 'method') kind = n;
  }
  if (!kind) return null;
  const nargs = call.arguments.length;
  const configures = configured || (kind === 'fn' && nargs > 0) || (kind === 'method' && nargs >= 3);
  return { kind, call, configures };
}

/** Find mock configuration in a subtree (top-level setup or a single test body). */
function scanMocks(source: string, root: Node, skip?: (n: Node) => boolean, mv: MockVocab = EMPTY_MOCKS): MockScan {
  const setups: MockSetup[] = [];
  walk(root, (node) => {
    if (skip && skip(node)) return false;
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      const factory = mockFactory(unwrap(node.init), mv);
      if (factory) {
        setups.push({ target: node.id.name, line: node.loc!.start.line, configuresReturn: factory.configures });
        if (factory.kind !== 'fn') {
          const target = spyTarget(source, factory.call);
          if (target) setups.push({ target, line: node.loc!.start.line, configuresReturn: factory.configures });
        }
      }
    }
    // node:test: t.mock.method(obj, 'm', impl) as a statement replaces obj.m in place
    const bare = isCall(node) ? mockFactory(node, mv) : null;
    if (bare && bare.call === node && bare.kind === 'method' && bare.configures) {
      const target = spyTarget(source, bare.call);
      if (target) setups.push({ target, line: node.loc!.start.line, configuresReturn: true });
    }
    if (isCall(node) && isMember(node.callee as Node)) {
      const callee = node.callee as t.MemberExpression;
      const name = propName(callee);
      if (name && MOCK_CONFIG.test(name)) {
        const target = mockTargetText(source, callee.object, mv);
        if (target) setups.push({ target, line: node.loc!.start.line, configuresReturn: true });
      }
    }
  });
  return { setups };
}

function innermostCall(call: Node): t.CallExpression {
  let cur: Node = call;
  let last = call as t.CallExpression;
  for (;;) {
    if (isCall(cur)) {
      last = cur as t.CallExpression;
      cur = cur.callee as Node;
    } else if (isMember(cur)) cur = cur.object;
    else return last;
  }
}

function spyTarget(source: string, spy: t.CallExpression): string | null {
  const [obj, method] = spy.arguments as Node[];
  const m = stringValue(method);
  if (!obj || !m) return null;
  return `${normText(source, obj)}.${m}`;
}

/** Text of what a `.mockReturnValue` call configures: `fn`, `vi.mocked(fn)` -> `fn`, `vi.spyOn(o,'m')` -> `o.m`. */
function mockTargetText(source: string, obj: Node, mv: MockVocab = EMPTY_MOCKS): string | null {
  const node = unwrap(obj);
  // node:test: fn.mock.mockImplementation(impl) configures `fn`
  if (isMember(node) && propName(node) === 'mock') return normText(source, node.object);
  if (isCall(node)) {
    const factory = mockFactory(node, mv);
    if (factory && factory.call === node && factory.kind !== 'fn') return spyTarget(source, factory.call);
    const root = chainRoot(node);
    const props = chainProps(node);
    if (root.type === 'Identifier' && (root.name === 'vi' || root.name === 'jest')) {
      if (props[0] === 'mocked' && node.arguments[0]) return normText(source, node.arguments[0] as Node);
      if (props[0] === 'spyOn') return spyTarget(source, innermostCall(node));
      return null;
    }
    // chained: fn.mockReturnValueOnce(1).mockReturnValueOnce(2)
    if (isMember(node.callee as Node)) {
      const n = propName(node.callee as t.MemberExpression);
      if (n && MOCK_CONFIG.test(n)) return mockTargetText(source, (node.callee as t.MemberExpression).object, mv);
    }
    return null;
  }
  return normText(source, node);
}

interface AssertionScan {
  assertions: Assertion[];
  helperAssertionCalls: number;
  hasAssertionCountGuard: boolean;
}

function calleeName(source: string, call: Node): string {
  return isCall(call) ? normText(source, call.callee as Node) : '';
}

/** A falsy literal, which a truthiness assertion always rejects. */
function isFalsyLiteral(node: Node | undefined): boolean {
  if (!node) return false;
  const n = unwrap(node);
  if (n.type === 'NumericLiteral') return n.value === 0;
  if (n.type === 'BooleanLiteral') return !n.value;
  if (n.type === 'NullLiteral') return true;
  if (n.type === 'Identifier') return n.name === 'undefined';
  return stringValue(n) === '';
}

/** `assert.ok(0)`, `assert(false)`, `t.ok(false)`: a deliberate "should not get here", i.e. `fail()`. */
function isFailMarker(source: string, call: Node): boolean {
  return isCall(call) && /(^|\.)(assert|ok|isOk|isTrue|true|truthy)$/.test(calleeName(source, call)) && isFalsyLiteral(call.arguments[0] as Node | undefined);
}

function containsFailOrThrow(source: string, node: Node | null | undefined): boolean {
  if (!node) return false;
  let found = false;
  walk(node, (n) => {
    if (found) return false;
    if (isFunction(n) || n.type === 'FunctionDeclaration') return n === node ? undefined : false;
    if (n.type === 'ThrowStatement') found = true;
    if (isCall(n) && (FAIL_CALLS.has(calleeName(source, n)) || CTX_FAIL.test(calleeName(source, n)) || isFailMarker(source, n))) found = true;
    return undefined;
  });
  return found;
}

/** Callbacks that fail the test when handed an error: `reject(err)`, `done(err)`, `t.fail(err)`, `t.ifError(err)`. */
const ERROR_SINKS = /^(reject|done|cb|callback|next|fail|ifError)$/;

/** `catch (err) { reject(err) }`: the error is passed on to something that fails the test, not swallowed. */
function forwardsError(handler: t.CatchClause): boolean {
  const param = handler.param;
  if (!param || param.type !== 'Identifier') return false;
  let found = false;
  walk(handler.body, (n) => {
    if (found) return false;
    // catch (err) { serverError = err }: kept for a later check
    if (n.type === 'AssignmentExpression' && n.right.type === 'Identifier' && n.right.name === param.name) found = true;
    if (!isCall(n) || !(n.arguments as Node[]).some((a) => a.type === 'Identifier' && a.name === param.name)) return undefined;
    const callee = n.callee as Node;
    const name = callee.type === 'Identifier' ? callee.name : isMember(callee) ? propName(callee) : null;
    if (name && ERROR_SINKS.test(name)) found = true;
    return undefined;
  });
  return found;
}

/**
 * `catch (err) { assert.equal(err.name, 'TypeError') }`: the catch asserts on details of the error
 * (a property, `instanceof`), which an AssertionError thrown in the `try` would not satisfy, so a failing
 * assertion in the `try` still fails the test. A bare truthiness check (`assert.ok(err)`) passes for any error.
 */
function checksErrorDetails(handler: t.CatchClause, vocab: AssertVocab): boolean {
  const param = handler.param;
  if (!param || param.type !== 'Identifier') return false;
  const isDetail = (n: Node) =>
    (isMember(n) && unwrap(n.object).type === 'Identifier' && (unwrap(n.object) as t.Identifier).name === param.name) ||
    (n.type === 'BinaryExpression' && n.operator === 'instanceof' && n.left.type === 'Identifier' && n.left.name === param.name);
  let found = false;
  walk(handler.body, (n) => {
    if (found) return false;
    if (!isAssertionCall(n, vocab) || !isCall(n)) return undefined;
    for (const arg of n.arguments as Node[]) {
      walk(arg, (m) => {
        if (found || isFunction(m)) return false;
        if (isDetail(m)) found = true;
        return undefined;
      });
    }
    return undefined;
  });
  return found;
}

/** `vi.mock('./x', async (orig) => ({ ...(await orig()), f }))`: the factory pulls in the real module. */
function factoryCallsItsParam(factory: Node | undefined): boolean {
  if (!factory || !isFunction(factory)) return false;
  const param = factory.params[0];
  if (!param || param.type !== 'Identifier') return false;
  let found = false;
  walk(factory.body as Node, (n) => {
    if (found) return false;
    if (isCall(n) && n.callee.type === 'Identifier' && n.callee.name === param.name) found = true;
    return undefined;
  });
  return found;
}

/** What the file tells us about assertion entry points beyond `expect`/`assert`. */
interface AssertVocab {
  /** Local names bound to assertion functions: `import { equal as eq } from 'node:assert'` -> eq => equal. */
  assertFns: Map<string, string>;
  /** Local names bound to an assertion module object: `import a from 'node:assert/strict'`. */
  assertRoots: Set<string>;
  /** Functions declared in this file whose bodies assert (`function check(x) { expect(x)... }`). */
  helpers: Set<string>;
  /**
   * Test-context objects whose methods assert, per test: tap/ava/tspl-style `t.equal(...)`, `t.is(...)`,
   * and `p.ok(...)` after `const p = tspl(t, { plan: 1 })`.
   */
  ctxObjects?: Set<string>;
}

/** Assertion methods of tap/ava/tspl test contexts (and node:assert's API, which tspl mirrors). */
const CTX_ASSERT =
  /^(ok|notOk|equal|notEqual|equals|strictEqual|notStrictEqual|deepEqual|notDeepEqual|deepStrictEqual|notDeepStrictEqual|partialDeepStrictEqual|throws|doesNotThrow|rejects|doesNotReject|match|doesNotMatch|ifError|fail|pass|same|notSame|strictSame|strictNotSame|is|not|true|false|truthy|falsy|like|unlike|regex|notRegex|throwsAsync|notThrows|notThrowsAsync|has|hasStrict|type|error)$/;

/** `require('node:assert').strictEqual(...)`: a method of an assertion module required inline. */
function isInlineRequiredAssert(callee: Node): boolean {
  if (!isMember(callee)) return false;
  let cur = unwrap(callee.object);
  while (isMember(cur)) cur = unwrap(cur.object);
  return isCall(cur) && cur.callee.type === 'Identifier' && cur.callee.name === 'require' && ASSERT_MODULES.test(stringValue(cur.arguments[0] as Node) ?? '');
}

/** Assertion methods that aren't reached from a known root name: `t.assert.x`, `t.equal`, `require('assert').x`. */
function isAssertMethod(callee: Node, vocab: AssertVocab): boolean {
  return isContextAssert(callee) || isCtxAssert(callee, vocab) || isInlineRequiredAssert(callee);
}

/** `t.equal(...)` on a test-context object that asserts. */
function isCtxAssert(callee: Node, vocab: AssertVocab): boolean {
  return !!vocab.ctxObjects && isMember(callee) && callee.object.type === 'Identifier' && vocab.ctxObjects.has(callee.object.name) && CTX_ASSERT.test(propName(callee) ?? '');
}

const EMPTY_VOCAB: AssertVocab = { assertFns: new Map(), assertRoots: new Set(['assert']), helpers: new Set() };

/** node:test's `t.assert.equal(...)`: an assertion namespace hanging off the test context. */
function isContextAssert(callee: Node): boolean {
  return isMember(callee) && isMember(callee.object) && propName(callee.object) === 'assert' && callee.object.object.type === 'Identifier';
}

/** True if `call` starts or is an assertion: expect chains, assert.*, imported assert fns, asserting helpers. */
function isAssertionCall(call: Node, vocab: AssertVocab): boolean {
  if (!isCall(call)) return false;
  const callee = call.callee as Node;
  if (isAssertMethod(callee, vocab)) return true;
  const root = chainRoot(callee);
  if (root.type === 'Identifier') {
    if (root.name === 'expect' || vocab.assertRoots.has(root.name)) return true;
    if (callee === root && (vocab.assertFns.has(root.name) || vocab.helpers.has(root.name))) return true;
  }
  const name = callee.type === 'Identifier' ? callee.name : isMember(callee) ? propName(callee) : null;
  if (name && HELPER_ASSERT.test(name)) return true;
  return isMember(callee) && chainProps(callee).includes('should');
}

function containsAssertion(node: Node | null | undefined, vocab: AssertVocab): boolean {
  if (!node) return false;
  let found = false;
  walk(node, (n) => {
    if (found) return false;
    if (isAssertionCall(n, vocab)) found = true;
    return undefined;
  });
  return found;
}

/** `if (a) {assert} else if (b) {assert} else {assert}`: some assertion runs whichever branch is taken. */
function everyBranchAsserts(node: Node, vocab: AssertVocab): boolean {
  if (node.type === 'IfStatement') {
    if (!node.alternate || !containsAssertion(node.consequent, vocab)) return false;
    return everyBranchAsserts(node.alternate, vocab);
  }
  if (node.type === 'ConditionalExpression') return containsAssertion(node.consequent, vocab) && containsAssertion(node.alternate, vocab);
  return containsAssertion(node, vocab);
}

/** The value a guard tests: `!r.success` / `r.success === false` / `(x)` -> `r.success` / `x`. */
function guardOperand(source: string, test: Node): string {
  let node = unwrap(test);
  for (;;) {
    if (node.type === 'UnaryExpression' && node.operator === '!') node = unwrap(node.argument as Node);
    else if (node.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(node.operator)) {
      const right = unwrap(node.right as Node);
      const left = unwrap(node.left as Node);
      const isConst = (n: Node) =>
        n.type === 'BooleanLiteral' ||
        n.type === 'NullLiteral' ||
        n.type === 'StringLiteral' ||
        n.type === 'NumericLiteral' ||
        (n.type === 'Identifier' && n.name === 'undefined');
      if (isConst(right)) node = left;
      else if (isConst(left)) node = right;
      else break;
    } else break;
  }
  return normText(source, node);
}

function containsReturn(node: Node): boolean {
  let found = false;
  walk(node, (n) => {
    if (found || isFunction(n) || n.type === 'FunctionDeclaration') return false;
    if (n.type === 'ReturnStatement') found = true;
    return undefined;
  });
  return found;
}

/** Variables the catch body sets to `true` (`threw = true`), so a later `expect(threw)` proves it ran. */
function flagsSetIn(node: Node): string[] {
  const out: string[] = [];
  walk(node, (n) => {
    if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && unwrap(n.right as Node).type === 'BooleanLiteral') out.push(n.left.name);
  });
  return out;
}

/**
 * A catch whose skipping fails the test anyway: the try throws/fails after the risky call, the catch
 * returns and the code after the try fails, or the catch sets a flag that is asserted afterwards.
 */
function catchIsGuarded(source: string, tryStmt: t.TryStatement, parent: Node | undefined, vocab: AssertVocab): boolean {
  if (containsFailOrThrow(source, tryStmt.block)) return true;
  const handler = tryStmt.handler;
  if (!handler || !parent || !('body' in parent) || !Array.isArray(parent.body)) return false;
  const siblings = parent.body as Node[];
  const after = siblings.slice(siblings.indexOf(tryStmt) + 1);
  if (after.length === 0) return false;
  if (containsReturn(handler.body) && after.some((s) => containsFailOrThrow(source, s))) return true;
  const flags = flagsSetIn(handler.body);
  if (flags.length === 0) return false;
  return after.some((s) => {
    let hit = false;
    walk(s, (n) => {
      if (hit) return false;
      if (isAssertionCall(n, vocab) && isCall(n) && (n.arguments as Node[]).some((a) => a.type === 'Identifier' && flags.includes(a.name))) hit = true;
      return undefined;
    });
    return hit;
  });
}

function assertionContext(source: string, target: Node, ancestors: Node[], bodyIndex: number, vocab: AssertVocab = EMPTY_VOCAB): AssertionContext {
  const ctx: AssertionContext = { inSwallowingTry: false, inCatch: false, catchGuarded: false, inConditional: false };
  const guards: string[] = [];
  for (let i = ancestors.length - 1; i >= bodyIndex; i--) {
    const a = ancestors[i]!;
    const child = ancestors[i + 1] ?? target;
    if (a.type === 'CatchClause') {
      ctx.inCatch = true;
      const tryStmt = ancestors[i - 1];
      if (tryStmt && tryStmt.type === 'TryStatement' && catchIsGuarded(source, tryStmt, ancestors[i - 2], vocab)) ctx.catchGuarded = true;
    }
    if (a.type === 'TryStatement' && child === a.block && a.handler) {
      if (!containsFailOrThrow(source, a.handler.body) && !forwardsError(a.handler) && !checksErrorDetails(a.handler, vocab)) ctx.inSwallowingTry = true;
    }
    if ((a.type === 'IfStatement' || a.type === 'ConditionalExpression') && child !== a.test) {
      // Walk up an else-if chain to its head; if every branch asserts, something is always checked.
      let j = i;
      while (j - 1 >= bodyIndex) {
        const up = ancestors[j - 1]!;
        if (up.type === 'IfStatement' && up.alternate === ancestors[j]) j--;
        else break;
      }
      if (!everyBranchAsserts(ancestors[j]!, vocab)) {
        ctx.inConditional = true;
        guards.push(guardOperand(source, a.test as Node));
      }
    }
    if (a.type === 'LogicalExpression' && child === a.right) {
      ctx.inConditional = true;
      // `expect(a).toBe(1) && expect(b)...`: the left side is an assertion returning undefined — never excusable.
      guards.push(isAssertionCall(chainCallOf(a.left as Node), vocab) ? '\u0000assertion' : guardOperand(source, a.left as Node));
    }
  }
  if (guards.length) ctx.guards = guards;
  if (ancestors.slice(bodyIndex).some((a) => isFunction(a) || a.type === 'FunctionDeclaration' || a.type === 'ObjectMethod')) ctx.inCallback = true;
  return ctx;
}

/** Innermost call at the root of a matcher chain (`expect(x).toBe(1)` -> `expect(x)`). */
function chainCallOf(node: Node): Node {
  let cur = unwrap(node);
  for (;;) {
    if (isCall(cur) && isMember(cur.callee as Node)) cur = (cur.callee as t.MemberExpression).object;
    else if (isMember(cur)) cur = cur.object;
    else return cur;
  }
}

/** TS wrappers / parens that don't change a value. */
const VALUE_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression', 'AwaitExpression']);
const PURE_GLOBALS = new Set(['undefined', 'NaN', 'Infinity']);

/** Test-local literal bindings: name -> declaration line and initializer. */
type PureBindings = Map<string, { line: number; init: Node }>;

/** A value we know is a primitive (e.g. an array's `length`) but whose node we can't point at. */
const PRIMITIVE = Symbol('primitive');

/** Static key of a member read or object property: `p.a`, `p['a']`, `p[0]`, `{ a: 1 }`, `{ 'a': 1 }`. */
function staticKey(key: Node, computed: boolean, pure: PureBindings): string | null {
  if (!computed) return key.type === 'Identifier' ? key.name : key.type === 'StringLiteral' ? key.value : key.type === 'NumericLiteral' ? String(key.value) : null;
  const k = resolveLiteral(key, pure);
  if (k === PRIMITIVE || !k) return null;
  if (k.type === 'StringLiteral') return k.value;
  if (k.type === 'NumericLiteral') return String(k.value);
  return stringValue(k);
}

/** Look `key` up among an object literal's own properties (later ones win; spreads of known literals are followed). */
function ownProperty(obj: t.ObjectExpression, key: string, pure: PureBindings): Node | typeof PRIMITIVE | null {
  for (let i = obj.properties.length - 1; i >= 0; i--) {
    const p = obj.properties[i]!;
    if (p.type === 'SpreadElement') {
      const inner = resolveLiteral(p.argument, pure);
      if (inner && inner !== PRIMITIVE && inner.type === 'ObjectExpression') {
        const hit = ownProperty(inner, key, pure);
        if (hit) return hit;
        continue;
      }
      return null;
    }
    if (p.type !== 'ObjectProperty') return null;
    const k = staticKey(p.key as Node, p.computed, pure);
    if (k === null) return null;
    if (k === key) return p.value as Node;
  }
  return null;
}

/**
 * The literal node a pure expression evaluates to, following bindings and own-property reads.
 * Returns null when a read isn't an own property written in the literal: `{}.polluted` comes from
 * the prototype, which code under test can change (prototype-pollution tests rely on exactly that).
 */
function resolveLiteral(node: Node, pure: PureBindings): Node | typeof PRIMITIVE | null {
  const n = unwrap(node);
  if (n.type === 'Identifier') return pure.has(n.name) ? resolveLiteral(pure.get(n.name)!.init, pure) : null;
  if (!isMember(n)) return n;
  const obj = resolveLiteral(n.object, pure);
  const key = staticKey(n.property as Node, n.computed, pure);
  if (!obj || obj === PRIMITIVE || key === null) return null;
  if (obj.type === 'ObjectExpression') {
    const v = ownProperty(obj, key, pure);
    return v === null ? null : v === PRIMITIVE ? PRIMITIVE : resolveLiteral(v, pure);
  }
  const isString = obj.type === 'StringLiteral' || obj.type === 'TemplateLiteral';
  if (obj.type !== 'ArrayExpression' && !isString) return null;
  if (key === 'length') return PRIMITIVE;
  if (!/^\d+$/.test(key)) return null;
  if (isString) return PRIMITIVE;
  const els = (obj as t.ArrayExpression).elements;
  if (els.some((e) => !e || e.type === 'SpreadElement')) return null;
  const el = els[Number(key)];
  return el ? resolveLiteral(el as Node, pure) : null;
}

/**
 * True if `node` is built only from literals and `pure` bindings: object/array/template literals,
 * operators and own-property reads. Any call, `new`, function, import or outer identifier makes it
 * impure, as does a read that could reach the prototype.
 */
function isPureValue(node: Node, pure: PureBindings): boolean {
  const n = unwrap(node);
  switch (n.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'BigIntLiteral':
    case 'RegExpLiteral':
      return true;
    case 'Identifier':
      return PURE_GLOBALS.has(n.name) || pure.has(n.name);
    case 'TemplateLiteral':
      return n.expressions.every((e) => isPureValue(e as Node, pure));
    case 'ObjectExpression':
      return n.properties.every((p) => {
        if (p.type === 'SpreadElement') return isPureValue(p.argument, pure);
        if (p.type !== 'ObjectProperty') return false; // methods and getters run code
        if (p.computed && !isPureValue(p.key, pure)) return false;
        return isPureValue(p.value as Node, pure);
      });
    case 'ArrayExpression':
      return n.elements.every((e) => !e || isPureValue(e.type === 'SpreadElement' ? e.argument : e, pure));
    case 'UnaryExpression':
      return n.operator !== 'delete' && isPureValue(n.argument, pure);
    case 'BinaryExpression':
      // `in` / `instanceof` consult the prototype chain.
      if (n.operator === 'in' || n.operator === 'instanceof') return false;
      return n.left.type !== 'PrivateName' && isPureValue(n.left as Node, pure) && isPureValue(n.right, pure);
    case 'LogicalExpression':
      return isPureValue(n.left, pure) && isPureValue(n.right, pure);
    case 'ConditionalExpression':
      return isPureValue(n.test, pure) && isPureValue(n.consequent, pure) && isPureValue(n.alternate, pure);
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      if (n.computed && !isPureValue(n.property as Node, pure)) return false;
      return isPureValue(n.object, pure) && resolveLiteral(n, pure) !== null;
    default:
      return false;
  }
}

/** First pure binding an expression reads, for evidence. */
function firstPureRef(node: Node, pure: PureBindings): string | null {
  let found: string | null = null;
  walk(node, (n, anc) => {
    if (found) return false;
    const parent = anc[anc.length - 1];
    if (n.type !== 'Identifier' || !pure.has(n.name)) return undefined;
    if (parent && isMember(parent) && parent.property === n && !parent.computed) return undefined;
    if (parent && parent.type === 'ObjectProperty' && parent.key === n && parent.value !== n && !parent.computed) return undefined;
    found = n.name;
    return undefined;
  });
  return found;
}

/** A call whose arguments only get compared, never mutated: expect(...), matcher calls, assert.*. */
function isComparingCall(call: Node, vocab: AssertVocab): boolean {
  if (!isCall(call)) return false;
  const callee = call.callee as Node;
  if (isAssertMethod(callee, vocab)) return true;
  const root = chainRoot(callee);
  if (root.type !== 'Identifier') return false;
  if (root.name === 'expect') return true;
  if (vocab.assertRoots.has(root.name)) return true;
  return callee === root && vocab.assertFns.has(root.name);
}

const PURE_CONTAINERS = new Set([
  'MemberExpression',
  'OptionalMemberExpression',
  'ObjectProperty',
  'ObjectExpression',
  'ArrayExpression',
  'SpreadElement',
  'TemplateLiteral',
  'BinaryExpression',
  'LogicalExpression',
  'ConditionalExpression',
  ...VALUE_WRAPPERS,
]);

/**
 * Variables in a test body bound to values built purely from literals (`const p = { service: 's3' }`)
 * and only ever read by assertions or by other such literals — never passed to code, mutated or
 * reassigned.
 */
function ownLiteralBindings(body: Node, vocab: AssertVocab): PureBindings {
  const decls = new Map<string, t.VariableDeclarator>();
  const bindingCount = new Map<string, number>();
  const bump = (name: string) => bindingCount.set(name, (bindingCount.get(name) ?? 0) + 1);
  walk(body, (n) => {
    if (n.type === 'VariableDeclarator') {
      if (n.id.type === 'Identifier') {
        bump(n.id.name);
        if (n.init) decls.set(n.id.name, n);
      } else walk(n.id, (p) => void (p.type === 'Identifier' && bump(p.name)));
    }
    if (isFunction(n) || n.type === 'FunctionDeclaration' || n.type === 'CatchClause') {
      const params = n.type === 'CatchClause' ? (n.param ? [n.param] : []) : n.params;
      for (const p of params) walk(p as Node, (q) => void (q.type === 'Identifier' && bump(q.name)));
      if (n.type === 'FunctionDeclaration' && n.id) bump(n.id.name);
    }
  });
  const pure: PureBindings = new Map();
  for (const [name, d] of decls) if (bindingCount.get(name) === 1) pure.set(name, { line: d.loc!.start.line, init: d.init as Node });

  /** Every read of a pure binding must end in an assertion's arguments or another pure literal. */
  const referencesOk = (name: string): boolean => {
    let ok = true;
    walk(body, (n, anc) => {
      if (!ok) return false;
      if (n.type !== 'Identifier' || n.name !== name) return undefined;
      const parent = anc[anc.length - 1];
      if (!parent) return undefined;
      if (parent.type === 'VariableDeclarator' && parent.id === n) return undefined;
      if (isMember(parent) && parent.property === n && !parent.computed) return undefined;
      if (parent.type === 'ObjectProperty' && parent.key === n && parent.value !== n && !parent.computed) return undefined;
      if (anc.some((a) => a.type.startsWith('TS') && !VALUE_WRAPPERS.has(a.type))) return undefined; // type position
      let child: Node = n;
      for (let i = anc.length - 1; i >= 0; i--) {
        const p = anc[i]!;
        const climbs =
          PURE_CONTAINERS.has(p.type) ||
          (p.type === 'UnaryExpression' && p.operator !== 'delete');
        // A member read climbs only from its object (or computed key); `p.x(...)` is caught at the call.
        if (climbs && !(p.type === 'ObjectProperty' && (p as t.ObjectProperty).key === child && !(p as t.ObjectProperty).computed)) {
          child = p;
          continue;
        }
        if (p.type === 'VariableDeclarator' && p.init === child && p.id.type === 'Identifier' && pure.has(p.id.name)) return undefined;
        if (isCall(p) && (p.arguments as Node[]).includes(child) && isComparingCall(p, vocab)) return undefined;
        ok = false;
        return false;
      }
      ok = false;
      return false;
    });
    return ok;
  };

  for (let changed = true; changed; ) {
    changed = false;
    for (const name of [...pure.keys()]) {
      if (isPureValue(pure.get(name)!.init, pure) && referencesOk(name)) continue;
      pure.delete(name);
      changed = true;
    }
  }
  return pure;
}

/** Attach `ownLiteral` when an assertion operand reads only test-local literal bindings. */
function withOwnLiteral(info: ExprInfo, node: Node, pure: PureBindings): ExprInfo {
  if (info.kind === 'literal' || !isPureValue(node, pure)) return info;
  const name = firstPureRef(node, pure);
  // Inline literals (`expect({ a: 1 })`) are tautological-/never-failing-assertion's territory.
  if (!name) return { ...info, pureLiteral: true };
  return { ...info, pureLiteral: true, ownLiteral: { name, line: pure.get(name)!.line } };
}

interface ScanScope {
  /** Subtest bodies (`t.test(...)`, `t.step(...)`): their assertions belong to the subtest. */
  skip?: Set<Node>;
  /** The test's context parameter (`t`), for `t.plan(n)`. */
  ctx?: string | null;
}

function scanAssertions(
  source: string,
  lines: string[],
  body: Node,
  aliases: Map<string, Alias>,
  vocab: AssertVocab = EMPTY_VOCAB,
  scope: ScanScope = {},
): AssertionScan {
  const assertions: Assertion[] = [];
  const pure = ownLiteralBindings(body, vocab);
  const describeOperand = (n: Node) => withOwnLiteral(describeExpr(source, n), n, pure);
  let helperAssertionCalls = 0;
  let hasAssertionCountGuard = false;

  const withAlias = (info: ExprInfo): ExprInfo => {
    const alias = info.kind === 'identifier' ? aliases.get(info.text) : undefined;
    if (alias) return { ...info, aliasCalleeText: alias.callee, callArgRoots: alias.argRoots };
    return info;
  };

  walk(body, (node, ancestors) => {
    if (scope.skip?.has(node)) return false;
    // An assertion handed over as a handler: `ws.on('error', t.assert.fail)`, `t.assert.ok.bind(null, true)`.
    if (isMember(node) && isAssertMethod(node, vocab)) {
      const parent = ancestors[ancestors.length - 1];
      const called = parent && isCall(parent) && parent.callee === node;
      const chained = parent && isMember(parent) && parent.object === node && propName(parent) !== 'bind';
      if (!called && !chained) helperAssertionCalls++;
    }
    if (!isCall(node)) return;
    const callee = node.callee as Node;
    const bodyIndex = 0;

    // node:test t.plan(n): the test fails unless exactly n assertions run.
    if (scope.ctx && isMember(callee) && callee.object.type === 'Identifier' && callee.object.name === scope.ctx && propName(callee) === 'plan') {
      hasAssertionCountGuard = true;
      return;
    }

    // expect.assertions(n) / expect.hasAssertions()
    if (isMember(callee) && callee.object.type === 'Identifier' && callee.object.name === 'expect') {
      const n = propName(callee);
      if (n === 'assertions' || n === 'hasAssertions') hasAssertionCountGuard = true;
      if (!EXPECT_ENTRY_PROPS.has(n ?? '')) return;
    }

    const isExpectRoot =
      (callee.type === 'Identifier' && callee.name === 'expect') ||
      (isMember(callee) && callee.object.type === 'Identifier' && callee.object.name === 'expect' && EXPECT_ENTRY_PROPS.has(propName(callee) ?? ''));
    // expect.poll(fn) asserts on what fn returns, not on the function object.
    const polls = isMember(callee) && propName(callee) === 'poll';

    if (isExpectRoot) {
      // Climb the matcher chain: expect(x).not.resolves.toBe(y)
      const props: string[] = [];
      let cur: Node = node;
      let called = false;
      let args: Node[] = [];
      let i = ancestors.length - 1;
      for (; i >= 0; i--) {
        const p = ancestors[i]!;
        if (isMember(p) && p.object === cur) {
          const n = propName(p);
          if (n) props.push(n);
          cur = p;
          continue;
        }
        if (isCall(p) && p.callee === cur) {
          called = true;
          args = p.arguments as Node[];
          cur = p;
        }
        break;
      }
      const outerParent = called ? ancestors[i - 1] : ancestors[i];
      const matcher = [...props].reverse().find((p) => !MODIFIER_WORDS.has(p)) ?? null;
      const chaiStyle = props.some((p) => CHAI_WORDS.has(p));
      let kind = matcherKindOf(matcher);
      if (!called && !chaiStyle) kind = 'none';
      if (matcher === 'true' && chaiStyle) kind = 'equal';
      const isAsync = props.includes('resolves') || props.includes('rejects');
      const awaited =
        cur === body ||
        (!!outerParent &&
        (outerParent.type === 'AwaitExpression' ||
          outerParent.type === 'ReturnStatement' ||
          outerParent.type === 'ArrayExpression' ||
          (outerParent.type === 'ArrowFunctionExpression' && outerParent.body === cur) ||
          (isMember(outerParent) && ['then', 'catch', 'finally'].includes(propName(outerParent) ?? '')) ||
          // const pending = expect(p).rejects.toThrow(); ...; await pending
          (outerParent.type === 'VariableDeclarator' && outerParent.id.type === 'Identifier' && isReferencedElsewhere(body, outerParent.id))));
      const subjectNode = node.arguments[0] as Node | undefined;
      let subject = subjectNode ? withAlias(describeOperand(subjectNode)) : null;
      if (subject && polls) subject = { text: subject.text, kind: 'other' };
      const start = node.loc!.start;
      assertions.push({
        line: start.line,
        column: start.column + 1,
        text: lineText(lines, start.line, cur.loc!.end.line),
        style: 'expect',
        subject,
        matcher,
        matcherKind: kind,
        negated: props.includes('not'),
        args: args.map(describeOperand),
        async: isAsync,
        awaitedOrReturned: awaited,
        context: assertionContext(source, node, ancestors, bodyIndex, vocab),
      });
      return;
    }

    // assert(x) / assert.equal(a, b) / assert.strict.equal(...) / equal(a, b) imported from node:assert
    const root = chainRoot(callee);
    const importedFn = callee.type === 'Identifier' ? vocab.assertFns.get(callee.name) : undefined;
    if (importedFn !== undefined || isAssertMethod(callee, vocab) || (root.type === 'Identifier' && vocab.assertRoots.has(root.name) && (callee === root || isMember(callee)))) {
      const method = importedFn ?? (callee === root ? 'assert' : propName(callee as t.MemberExpression));
      if (method === 'fail' || method === 'pass' || isFailMarker(source, node)) {
        helperAssertionCalls++;
        return;
      }
      const start = node.loc!.start;
      const m = method ?? 'assert';
      // Deno's assertSnapshot(t, value) takes the test context first.
      const callArgs = (node.arguments as Node[]).slice(/^assert(Inline)?Snapshot$/.test(m) ? 1 : 0);
      let [subj, ...rest] = callArgs;
      // node:assert is (actual, expected), but `strictEqual('hello', await body.text())` puts the expected
      // literal first; the computed side is the subject.
      if (subj && rest[0] && matcherKindOf(m) === 'equal' && describeExpr(source, subj).kind === 'literal' && describeExpr(source, rest[0]).kind !== 'literal') {
        [subj, rest[0]] = [rest[0], subj];
      }
      assertions.push({
        line: start.line,
        column: start.column + 1,
        text: lineText(lines, start.line, node.loc!.end.line),
        style: 'assert',
        subject: subj ? withAlias(describeOperand(subj)) : null,
        matcher: m,
        matcherKind: matcherKindOf(m),
        negated: /^(not|isNot|doesNot|assertNot)/.test(m),
        args: rest.slice(0, 1).map(describeOperand),
        async: m === 'rejects' || m === 'doesNotReject',
        awaitedOrReturned: true,
        context: assertionContext(source, node, ancestors, bodyIndex, vocab),
      });
      return;
    }

    // Helper assertions: expectValidUser(u), assertOk(res), request(app).get('/').expect(200), x.should.equal(1)
    const name = callee.type === 'Identifier' ? callee.name : isMember(callee) ? propName(callee) : null;
    if (name && (HELPER_ASSERT.test(name) || name === 'expect')) helperAssertionCalls++;
    else if (callee.type === 'Identifier' && vocab.helpers.has(callee.name)) helperAssertionCalls++;
    else if (isMember(callee) && chainProps(callee).includes('should')) helperAssertionCalls++;
    return;
  });

  return { assertions, helperAssertionCalls, hasAssertionCountGuard };
}

/** True if `id` is used anywhere in `scope` other than at its own declaration. */
function isReferencedElsewhere(scope: Node, id: t.Identifier): boolean {
  let found = false;
  walk(scope, (n) => {
    if (found) return false;
    if (n.type === 'Identifier' && n !== id && n.name === id.name) found = true;
    return undefined;
  });
  return found;
}

/** `const r = f(a)`: the call a local name holds. */
interface Alias {
  callee: string;
  argRoots: string[];
}

function collectAliases(source: string, body: Node): Map<string, Alias> {
  const aliases = new Map<string, Alias>();
  walk(body, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      const init = unwrap(node.init);
      if (isCall(init)) aliases.set(node.id.name, { callee: normText(source, init.callee as Node), argRoots: rootNames(init.arguments as Node[]) });
    }
  });
  return aliases;
}

/** Which local names are assertion functions/modules, and which file-local functions assert. */
function assertVocabulary(ast: t.File): AssertVocab {
  const assertFns = new Map<string, string>();
  const assertRoots = new Set<string>(['assert']);
  const bind = (imported: string, local: string) => {
    if (imported === 'expect') return;
    if (imported === 'assert' || imported === 'strict' || imported === 'default') assertRoots.add(local);
    else assertFns.set(local, imported);
  };
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'ImportDeclaration' || !ASSERT_MODULES.test(stmt.source.value)) continue;
    for (const sp of stmt.specifiers) {
      if (sp.type === 'ImportSpecifier') bind(sp.imported.type === 'Identifier' ? sp.imported.name : sp.imported.value, sp.local.name);
      else assertRoots.add(sp.local.name);
    }
  }
  // const assert = require('node:assert'); const { equal } = require('assert/strict')
  walk(ast, (node) => {
    if (node.type !== 'VariableDeclarator' || !node.init) return;
    let init = unwrap(node.init);
    if (isMember(init) && propName(init) === 'strict') init = init.object;
    if (!isCall(init) || init.callee.type !== 'Identifier' || init.callee.name !== 'require') return;
    const spec = stringValue(init.arguments[0] as Node);
    if (!spec || !ASSERT_MODULES.test(spec)) return;
    if (node.id.type === 'Identifier') assertRoots.add(node.id.name);
    else if (node.id.type === 'ObjectPattern') {
      for (const prop of node.id.properties) {
        if (prop.type !== 'ObjectProperty' || prop.value.type !== 'Identifier') continue;
        const key = prop.key.type === 'Identifier' ? prop.key.name : stringValue(prop.key as Node);
        if (key) bind(key, prop.value.name);
      }
    }
  });

  // File-local helpers that assert: function check(x) { expect(x)... } / const check = (x) => assert.ok(x)
  const candidates = new Map<string, Node>();
  walk(ast, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id) candidates.set(node.id.name, node.body);
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && isFunction(unwrap(node.init))) {
      candidates.set(node.id.name, (unwrap(node.init) as t.ArrowFunctionExpression).body as Node);
    }
  });
  const vocab: AssertVocab = { assertFns, assertRoots, helpers: new Set() };
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, body] of candidates) {
      if (vocab.helpers.has(name) || !containsAssertion(body, vocab)) continue;
      vocab.helpers.add(name);
      changed = true;
    }
  }
  return vocab;
}

/** Names declared by functions/variables anywhere in the file (imports excluded). */
function declaredNames(ast: Node, withParams = false): Set<string> {
  const names = new Set<string>();
  const addPattern = (p: Node) => {
    if (p.type === 'Identifier') names.add(p.name);
    else if (p.type === 'ObjectPattern') {
      for (const prop of p.properties) addPattern(prop.type === 'RestElement' ? prop.argument : (prop.value as Node));
    } else if (p.type === 'ArrayPattern') {
      for (const el of p.elements) if (el) addPattern(el);
    } else if (p.type === 'AssignmentPattern') addPattern(p.left);
    else if (p.type === 'RestElement') addPattern(p.argument);
  };
  walk(ast, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id) names.add(node.id.name);
    if (node.type === 'VariableDeclarator') addPattern(node.id);
    if (withParams && (isFunction(node) || node.type === 'FunctionDeclaration')) for (const p of node.params) addPattern(p as Node);
  });
  return names;
}

/** `spy.mockRestore()` / `fn.mockReset()` / `vi.restoreAllMocks()` inside a test body. */
function scanRestores(source: string, body: Node, mv: MockVocab = EMPTY_MOCKS): MockRestore[] {
  const out: MockRestore[] = [];
  walk(body, (node) => {
    if (!isCall(node) || !isMember(node.callee as Node)) return;
    const callee = node.callee as t.MemberExpression;
    const name = propName(callee);
    if (!name) return;
    const line = node.loc!.start.line;
    const obj = callee.object;
    if (obj.type === 'Identifier' && (obj.name === 'vi' || obj.name === 'jest') && /^(restoreAllMocks|resetAllMocks)$/.test(name)) {
      out.push({ target: null, line });
    } else if (name === 'restore' && isMember(obj) && propName(obj) === 'mock') {
      // node:test: fn.mock.restore()
      out.push({ target: normText(source, obj.object), line });
    } else if (isMockTracker(obj as Node, mv) && /^(restoreAll|reset|restore)$/.test(name)) {
      // node:test: mock.restoreAll() / t.mock.reset(); bun: mock.restore()
      out.push({ target: null, line });
    } else if (MOCK_RESTORE.test(name)) {
      const target = mockTargetText(source, obj as Node, mv);
      if (target) out.push({ target, line });
    }
  });
  return out;
}

/**
 * A skip decided inside the body: mocha's `this.skip()`, node:test's `t.skip()` / `t.todo()`, as an
 * unconditional top-level statement (a guarded `if (!db) this.skip()` still runs elsewhere).
 */
function bodyModifier(fn: Node | undefined): TestModifier {
  if (!fn) return null;
  const body = (fn as t.ArrowFunctionExpression).body as Node;
  if (body.type !== 'BlockStatement') return null;
  const ctx = firstParamName(fn);
  for (const st of body.body) {
    if (st.type !== 'ExpressionStatement') continue;
    const e = unwrap(st.expression as Node);
    if (!isCall(e) || !isMember(e.callee as Node)) continue;
    const callee = e.callee as t.MemberExpression;
    const name = propName(callee);
    const isThis = callee.object.type === 'ThisExpression' && fn.type !== 'ArrowFunctionExpression';
    const isCtx = callee.object.type === 'Identifier' && callee.object.name === ctx;
    if (name === 'skip' && (isThis || isCtx)) return 'skip';
    if (name === 'todo' && isCtx) return 'todo';
  }
  return null;
}

/**
 * Callback-style tests (`it('emits', (done) => { bus.on('x', () => done()); ... })`) fail by timeout or
 * error unless the code calls back, so calling `done` from a callback or handing it to the code is a
 * check. Calling it synchronously at the end of the body is not. A parameter used as an object
 * (`t.test`, `t.assert`) is a test context, not a callback.
 */
/**
 * The test context's assertion vocabulary: `t` itself (tap/ava/tspl), objects derived from it
 * (`const p = tspl(t, { plan: 2 })`, `t = tspl(t)`), and functions destructured from those
 * (`const { strictEqual } = tspl(t)`). `planned` is set when one of them was given `{ plan: n }`.
 */
function contextVocab(fn: Node, vocab: AssertVocab): { vocab: AssertVocab; planned: boolean } {
  const ctx = firstParamName(fn);
  if (!ctx) return { vocab, planned: false };
  const objects = new Set([...(vocab.ctxObjects ?? []), ctx]);
  const fns = new Map(vocab.assertFns);
  let planned = false;
  walk((fn as t.Function).body as Node, (n) => {
    let id: Node;
    let init: Node;
    if (n.type === 'VariableDeclarator' && n.init) [id, init] = [n.id, unwrap(n.init)];
    else if (n.type === 'AssignmentExpression' && n.operator === '=') [id, init] = [n.left as Node, unwrap(n.right)];
    else return;
    if (!isCall(init) || !(init.arguments as Node[]).some((a) => a.type === 'Identifier' && objects.has(a.name))) return;
    if ((init.arguments as Node[]).some((a) => a.type === 'ObjectExpression' && optionProp(a, 'plan'))) planned = true;
    if (id.type === 'Identifier') objects.add(id.name);
    else if (id.type === 'ObjectPattern') {
      for (const p of id.properties) {
        if (p.type !== 'ObjectProperty' || p.value.type !== 'Identifier') continue;
        const key = p.key.type === 'Identifier' ? p.key.name : stringValue(p.key as Node);
        if (key && CTX_ASSERT.test(key)) fns.set(p.value.name, key);
      }
    }
  });
  return { vocab: { ...vocab, assertFns: fns, ctxObjects: objects }, planned };
}

const CALLBACK_PARAM = /^(done|cb|callback|next|finish|end)$/;

function callbackChecks(fn: Node, vocab: AssertVocab, skip?: Set<Node>): number {
  let total = 0;
  for (const p of (fn as t.Function).params) {
    if (p.type !== 'Identifier' || !CALLBACK_PARAM.test(p.name)) continue;
    let usedAsObject = false;
    let checks = 0;
    walk((fn as t.Function).body as Node, (n, anc) => {
      if (skip?.has(n)) return false;
      if (n.type !== 'Identifier' || n.name !== p.name) return undefined;
      const parent = anc[anc.length - 1];
      if (!parent) return undefined;
      if (isMember(parent) && parent.object === n) {
        if (propName(parent) !== 'fail') usedAsObject = true;
      } else if (isCall(parent) && (parent.arguments as Node[]).includes(n)) {
        if (!isAssertionCall(parent, vocab)) checks++;
      } else if (parent.type === 'ObjectProperty' && parent.value === n && anc.some((a) => isCall(a) && !isAssertionCall(a, vocab))) {
        // router.handle(req, { end: done }): handed to the code inside an argument object
        checks++;
      } else if (isCall(parent) && parent.callee === n && anc.some((a) => isFunction(a) || a.type === 'FunctionDeclaration' || a.type === 'ObjectMethod')) {
        checks++;
      }
      return undefined;
    });
    if (!usedAsObject) total += checks;
  }
  return total;
}

/** Local names of bun:test / node:test mock factories (`import { mock, spyOn } from 'bun:test'`). */
function mockVocabulary(ast: t.File): MockVocab {
  const mv: MockVocab = { mockFns: new Set(), spyFns: new Set(), mockObjects: new Set() };
  const bind = (mod: string, imported: string, local: string) => {
    if (imported === 'mock') {
      mv.mockObjects.add(local);
      if (mod === 'bun:test') mv.mockFns.add(local);
    } else if (imported === 'spyOn' && mod === 'bun:test') mv.spyFns.add(local);
  };
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'ImportDeclaration' || !MOCK_MODULES.test(stmt.source.value)) continue;
    for (const sp of stmt.specifiers) {
      if (sp.type === 'ImportSpecifier') bind(stmt.source.value, sp.imported.type === 'Identifier' ? sp.imported.name : sp.imported.value, sp.local.name);
    }
  }
  // const { mock } = require('node:test')
  walk(ast, (node) => {
    if (node.type !== 'VariableDeclarator' || !node.init || node.id.type !== 'ObjectPattern') return;
    const init = unwrap(node.init);
    if (!isCall(init) || init.callee.type !== 'Identifier' || init.callee.name !== 'require') return;
    const spec = stringValue(init.arguments[0] as Node);
    if (!spec || !MOCK_MODULES.test(spec)) return;
    for (const prop of node.id.properties) {
      if (prop.type !== 'ObjectProperty' || prop.value.type !== 'Identifier') continue;
      const key = prop.key.type === 'Identifier' ? prop.key.name : stringValue(prop.key as Node);
      if (key) bind(spec, key, prop.value.name);
    }
  });
  return mv;
}

function testName(source: string, arg: Node | undefined): string {
  if (!arg) return '<anonymous>';
  // Template names keep their spacing: `adds ${n} items`, not `adds ${n}items`.
  return stringValue(arg) ?? textOf(source, arg).replace(/\s+/g, ' ').trim();
}

export function parseJsTestFile(path: string, source: string): TestFileModel {
  const ast = parseSource(path, source);
  const lines = source.split(/\r?\n/);
  const tests: TestCase[] = [];
  const moduleMocks: ModuleMock[] = [];
  const unitSpies: SpyOnUnit[] = [];
  const unitName = unitNameForTestFile(path);

  // Imports: local name -> specifier
  const imports = new Map<string, string>();
  const importedSpecs = new Set<string>();
  for (const stmt of ast.program.body) {
    if (stmt.type === 'ImportDeclaration') {
      importedSpecs.add(stmt.source.value);
      for (const s of stmt.specifiers) imports.set(s.local.name, stmt.source.value);
    }
  }
  walk(ast, (node) => {
    // require('x') and dynamic import('x') also count as imports
    if (isCall(node) && node.callee.type === 'Identifier' && node.callee.name === 'require') {
      const s = stringValue(node.arguments[0] as Node);
      if (s) importedSpecs.add(s);
    }
    if (node.type === 'ImportExpression' || (isCall(node) && node.callee.type === 'Import')) {
      const arg = node.type === 'ImportExpression' ? (node as { source: Node }).source : (node.arguments[0] as Node);
      const s = stringValue(arg);
      if (s) importedSpecs.add(s);
    }
  });

  const vocab = assertVocabulary(ast);
  const mockVocab = mockVocabulary(ast);
  const localNames = declaredNames(ast);

  const isUnitSpec = (spec: string) => isLocalSpecifier(spec) && specifierUnitName(spec) === unitName && unitName.length > 0;
  const importsUnit = [...importedSpecs].some(isUnitSpec);

  // Locate test bodies first so file-level mock scanning can skip them.
  const testBodies = new Set<Node>();
  /** Test body -> bodies of its node:test subtests / Deno steps. */
  const subtestsOf = new Map<Node, Set<Node>>();

  walk(ast, (node, ancestors) => {
    if (node.type !== 'CallExpression') return;
    // A test-looking call inside a test body is not a test (runners reject nested tests): it's a local fn.
    // The exception is a subtest on the test's own context: node:test `t.test(...)`, Deno `t.step(...)`.
    let parentBody: Node | undefined;
    for (let i = ancestors.length - 1; i >= 0 && !parentBody; i--) if (testBodies.has(ancestors[i]!)) parentBody = ancestors[i];
    let info: TestCallInfo | null;
    if (parentBody) {
      const ctx = firstParamName(parentBody);
      info = ctx ? resolveSubtestCall(node, new Set([ctx])) : null;
      if (info?.fn) subtestsOf.set(parentBody, (subtestsOf.get(parentBody) ?? new Set()).add(info.fn));
    } else info = resolveTestCall(node, localNames);
    if (info) {
      const fn = info.fn;
      if (fn && info.kind === 'test') testBodies.add(fn);
      const start = node.loc!.start;
      const tc: TestCase = {
        name: testName(source, info.nameNode),
        kind: info.kind,
        line: start.line,
        endLine: node.loc!.end.line,
        modifier: info.modifier ?? (info.kind === 'test' ? bodyModifier(fn) : null),
        headText: lineText(lines, start.line, start.line),
        analyzable: !!fn,
        assertions: [],
        helperAssertionCalls: 0,
        hasAssertionCountGuard: false,
        mockSetups: [],
      };
      (tc as TestCase & { _fn?: Node })._fn = fn;
      if (info.parameterized) (tc as TestCase & { _table?: boolean })._table = true;
      tests.push(tc);
      return;
    }

    // bun:test / node:test: spyOn(unit, 'f') / mock.method(unit, 'f', impl) on the unit's own exports
    const factory = mockFactory(node, mockVocab);
    // (vi.spyOn / jest.spyOn are handled with vi.mock below.)
    const nonViSpy = factory?.kind === 'method' || (factory?.kind === 'spyOn' && (node.callee as Node).type === 'Identifier');
    if (factory && factory.call === node && nonViSpy) {
      const [obj] = node.arguments as Node[];
      const objName = obj && obj.type === 'Identifier' ? obj.name : null;
      if (objName && imports.has(objName) && isUnitSpec(imports.get(objName)!)) {
        unitSpies.push({ target: spyTarget(source, node) ?? normText(source, node), line: node.loc!.start.line, text: lineText(lines, node.loc!.start.line, node.loc!.end.line) });
      }
    }
    // bun:test mock.module('./x', factory) / node:test mock.module('./x', options)
    if (isMember(node.callee as Node) && propName(node.callee as t.MemberExpression) === 'module' && isMockTracker((node.callee as t.MemberExpression).object, mockVocab)) {
      const spec = stringValue(node.arguments[0] as Node);
      if (spec) {
        const factoryNode = node.arguments[1] as Node | undefined;
        const factoryText = factoryNode ? textOf(source, factoryNode) : '';
        moduleMocks.push({
          specifier: spec,
          line: node.loc!.start.line,
          text: lineText(lines, node.loc!.start.line, node.loc!.start.line),
          isUnitUnderTest: isUnitSpec(spec) && importsUnit,
          partial: /importOriginal|requireActual|importActual/.test(factoryText) || factoryCallsItsParam(factoryNode),
        });
      }
    }

    // vi.mock('../src/x') / jest.mock(...)
    const callee = node.callee as Node;
    if (isMember(callee) && callee.object.type === 'Identifier' && (callee.object.name === 'vi' || callee.object.name === 'jest')) {
      const fnName = propName(callee);
      if (fnName === 'spyOn') {
        const [obj] = node.arguments as Node[];
        const objName = obj && obj.type === 'Identifier' ? obj.name : null;
        if (objName && imports.has(objName) && isUnitSpec(imports.get(objName)!)) {
          unitSpies.push({
            target: spyTarget(source, node) ?? normText(source, node),
            line: node.loc!.start.line,
            text: lineText(lines, node.loc!.start.line, node.loc!.end.line),
          });
        }
      }
      if (fnName && MODULE_MOCK_FNS.has(fnName)) {
        const spec = stringValue(node.arguments[0] as Node);
        if (spec) {
          const factory = node.arguments[1] as Node | undefined;
          const factoryText = factory ? textOf(source, factory) : '';
          const partial = /importOriginal|requireActual|importActual/.test(factoryText) || factoryCallsItsParam(factory);
          moduleMocks.push({
            specifier: spec,
            line: node.loc!.start.line,
            text: lineText(lines, node.loc!.start.line, node.loc!.start.line),
            isUnitUnderTest: isUnitSpec(spec) && importsUnit,
            partial,
          });
        }
      }
    }
  });

  const fileLevel = scanMocks(source, ast, (n) => testBodies.has(n), mockVocab);

  // Only keep unit spies that actually replace behavior.
  const replacedTargets = new Set(fileLevel.setups.filter((s) => s.configuresReturn).map((s) => s.target));
  for (const fn of testBodies) for (const s of scanMocks(source, fn, undefined, mockVocab).setups) if (s.configuresReturn) replacedTargets.add(s.target);
  const behaviorSpies = unitSpies.filter((s) => replacedTargets.has(s.target));

  const ctxVocabOf = new Map<Node, AssertVocab>();
  for (const tc of tests) {
    const fn = (tc as TestCase & { _fn?: Node })._fn;
    const table = (tc as TestCase & { _table?: boolean })._table;
    delete (tc as TestCase & { _fn?: Node })._fn;
    delete (tc as TestCase & { _table?: boolean })._table;
    if (!fn || tc.kind !== 'test') continue;
    const fnBody = (fn as t.ArrowFunctionExpression).body as Node;
    const subtests = subtestsOf.get(fn);
    const aliases = collectAliases(source, fnBody);
    // A subtest also sees what its parent derived from the context (`const p = tspl(t)` used in `t.test`).
    const parent = [...subtestsOf].find(([, subs]) => subs.has(fn))?.[0];
    const ctx = contextVocab(fn, (parent && ctxVocabOf.get(parent)) || vocab);
    ctxVocabOf.set(fn, ctx.vocab);
    const scan = scanAssertions(source, lines, fnBody, aliases, ctx.vocab, { skip: subtests, ctx: firstParamName(fn) });
    tc.assertions = scan.assertions;
    tc.helperAssertionCalls = scan.helperAssertionCalls + (table ? 0 : callbackChecks(fn, ctx.vocab, subtests));
    tc.hasAssertionCountGuard = scan.hasAssertionCountGuard || ctx.planned;
    // A test that only groups subtests is a suite: the subtests are checked on their own.
    if (subtests?.size && tc.assertions.length === 0 && tc.helperAssertionCalls === 0 && !tc.hasAssertionCountGuard) {
      tc.kind = 'suite';
      continue;
    }
    tc.mockSetups = [...fileLevel.setups, ...scanMocks(source, fnBody, undefined, mockVocab).setups];
    const declared = declaredNames(fn, true);
    if (declared.size) tc.declaredNames = [...declared];
    const restores = scanRestores(source, fnBody, mockVocab);
    if (restores.length) tc.mockRestores = restores;
  }

  return { file: path, language: 'js', tests, moduleMocks, unitSpies: behaviorSpies, lines };
}
