/**
 * Language-neutral model of a test file.
 *
 * Language adapters (JS/TS today, pytest next) parse source into this model.
 * Rules only ever see the model, so a new adapter gets every rule for free.
 */

export type Severity = 'error' | 'warning' | 'info';

export type SubjectKind =
  | 'literal' // 1, 'a', true, null, `plain template`
  | 'identifier'
  | 'member'
  | 'call'
  | 'object'
  | 'array'
  | 'function'
  | 'new'
  | 'typeof'
  | 'other';

export interface ExprInfo {
  /** Normalized source text (whitespace collapsed). */
  text: string;
  kind: SubjectKind;
  /** For calls: normalized callee text, e.g. `mockFetch` or `api.get`. */
  calleeText?: string;
  /**
   * If the subject is an identifier bound in the test to the result of a call
   * (`const r = fn()`), the callee text of that call.
   */
  aliasCalleeText?: string;
  /** For literals: the literal's runtime truthiness / undefined-ness. */
  literalValue?: string | number | boolean | null | undefined;
  isUndefinedLiteral?: boolean;
  /**
   * Set when the value is built purely from literals constructed in this test
   * (`const p = { service: 's3' }; expect(p.service)`): no call, import or outer value is involved,
   * so the value is fixed before any code under test runs. `name`/`line` locate the literal binding.
   */
  ownLiteral?: { name: string; line: number };
  /** Built only from literals and test-local literal bindings (`{ a: 1 }`, `[x, 'y']`); implied by `ownLiteral`. */
  pureLiteral?: boolean;
  /**
   * For calls (and identifiers aliasing a call, `const r = f(a)`): root names the arguments read,
   * e.g. `total(cart.items, TAX)` -> `['cart', 'TAX']`.
   */
  callArgRoots?: string[];
  /**
   * Set when the expression is plain numeric arithmetic: `+ - * / % **`, unary minus, `Math.*` calls,
   * numeric literals, identifiers and member reads, nothing else (no strings, no other calls).
   */
  arithmetic?: {
    operators: string[];
    /** Root names read (`item.price * qty` -> `['item', 'qty']`). */
    identifiers: string[];
    hasNumericLiteral: boolean;
  };
  /** Source spelling of every decimal number literal in the expression (`79.98999999999999`). */
  decimalLiterals?: string[];
}

/** Normalized intent of an assertion matcher, independent of framework spelling. */
export type MatcherKind =
  | 'equal'
  | 'truthy'
  | 'falsy'
  | 'defined'
  | 'undefined'
  | 'null'
  | 'length'
  | 'compare-gte'
  | 'compare-other'
  | 'snapshot'
  | 'throws'
  | 'called'
  | 'type'
  | 'other'
  /** `expect(x)` with no matcher, or matcher referenced but never called. */
  | 'none';

export interface AssertionContext {
  /** Inside a `try` block whose `catch` does not rethrow. */
  inSwallowingTry: boolean;
  /** Inside a `catch` clause. */
  inCatch: boolean;
  /** Inside a `catch` whose `try` block calls fail()/throws after the risky call, so skipping the catch fails the test. */
  catchGuarded: boolean;
  /** Inside an `if`/ternary/`&&` guard (branches where every path asserts don't count). */
  inConditional: boolean;
  /**
   * Normalized text of the value each enclosing guard tests (`!r.success` -> `r.success`).
   * Lets rules excuse type-narrowing guards whose condition was already asserted.
   */
  guards?: string[];
}

export interface Assertion {
  line: number;
  column: number;
  /** Source line(s) of the assertion, trimmed — used as evidence. */
  text: string;
  style: 'expect' | 'assert';
  subject: ExprInfo | null;
  matcher: string | null;
  matcherKind: MatcherKind;
  negated: boolean;
  args: ExprInfo[];
  /** `.resolves` / `.rejects` used. */
  async: boolean;
  /** Awaited or returned (only meaningful when `async`). */
  awaitedOrReturned: boolean;
  context: AssertionContext;
}

export interface MockSetup {
  /** Normalized text of the mocked callable, e.g. `getUser` or `api.get`. */
  target: string;
  line: number;
  /** Whether a return value / implementation was configured. */
  configuresReturn: boolean;
}

/** `spy.mockRestore()` / `fn.mockReset()` (target set) or `vi.restoreAllMocks()` (target null). */
export interface MockRestore {
  target: string | null;
  line: number;
}

export type TestModifier = 'only' | 'skip' | 'todo' | null;

export interface TestCase {
  name: string;
  kind: 'test' | 'suite';
  line: number;
  endLine: number;
  modifier: TestModifier;
  /** Source text of the call head, e.g. `it.only('adds', ...` — evidence. */
  headText: string;
  /** False when the test body is not an inline function we could analyze. */
  analyzable: boolean;
  assertions: Assertion[];
  /** Calls to helpers that look like assertions (`expectValid(x)`, `assertOk()`, `request.expect(200)`). */
  helperAssertionCalls: number;
  /** `expect.assertions(n)` / `expect.hasAssertions()` present. */
  hasAssertionCountGuard: boolean;
  /** Mocks configured inside this test (or in file-level setup visible to it). */
  mockSetups: MockSetup[];
  /** Names the test body (or its parameters) declares: a `spy` here is not the `spy` of another test. */
  declaredNames?: string[];
  /** Mock restores/resets inside this test body; a configured mock is inactive after one. */
  mockRestores?: MockRestore[];
}

export interface ModuleMock {
  specifier: string;
  line: number;
  text: string;
  /** The adapter's judgement that this specifier is the module under test. */
  isUnitUnderTest: boolean;
  /** The mock keeps the real module and overrides only some exports. */
  partial: boolean;
}

export interface SpyOnUnit {
  /** e.g. `pricing.calculateTotal` */
  target: string;
  line: number;
  text: string;
}

export interface TestFileModel {
  file: string;
  language: string;
  tests: TestCase[];
  moduleMocks: ModuleMock[];
  /** spies on exports of the module under test that replace its behavior. */
  unitSpies: SpyOnUnit[];
  /** Raw source lines (for evidence + disable comments). */
  lines: string[];
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  file: string;
  line: number;
  column: number;
  message: string;
  /** The offending source line(s). */
  evidence: string;
  /** Name of the enclosing test, if any. */
  test?: string;
  /** Short actionable advice. */
  fix: string;
}

/** What a rule returns; the engine fills in ruleId/file/defaults. */
export interface RawFinding {
  line: number;
  column: number;
  message: string;
  evidence: string;
  test?: string;
  severity?: Severity;
  fix?: string;
}

export interface Rule {
  id: string;
  severity: Severity;
  /** One-line description for `honest-tests rules`. */
  description: string;
  /** Default fix advice. */
  fix: string;
  check(file: TestFileModel): RawFinding[];
}

/** A single source mutation. Offsets index into the original source string. */
export interface Mutant {
  id: number;
  file: string;
  line: number;
  column: number;
  start: number;
  end: number;
  original: string;
  replacement: string;
  operator: string;
  description: string;
}

export interface LanguageAdapter {
  id: string;
  /** File extensions this adapter understands. */
  extensions: string[];
  /** True if `path` looks like a test file for this language. */
  isTestFile(path: string): boolean;
  /** Parse a test file into the language-neutral model. */
  parseTestFile(path: string, source: string): TestFileModel;
  /** Generate mutants for a source (non-test) file. Optional. */
  generateMutants?(path: string, source: string): Mutant[];
  /** Return true if `testSource` (a test file) appears to import `targetPath`. */
  testImportsTarget?(testPath: string, testSource: string, targetPath: string): boolean;
  /** Normalized ids of local modules `source` imports, comparable with `moduleId`. */
  localImports?(path: string, source: string): string[];
  /** Normalized id of the module at `path` (e.g. extension and `/index` stripped). */
  moduleId?(path: string): string;
  /** Default command to run tests in `root`, or null if unknown. */
  defaultTestCommand?(root: string): string | null;
  /** Set when the adapter is a placeholder (parses nothing yet). */
  planned?: boolean;
}
