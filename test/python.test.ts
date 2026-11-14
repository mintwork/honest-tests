import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resetPythonLookup } from '../src/adapters/python/index.js';
import { audit, auditSource } from '../src/core/engine.js';

const ROOT = resolve(__dirname, '..');

const hasPython = ['python3', 'python'].some((bin) => spawnSync(bin, ['-c', 'import sys; assert sys.version_info >= (3, 9)']).status === 0);
// CI must exercise the adapter; locally it's skipped (with a note) when no Python 3.9+ is installed.
if (!hasPython && process.env.CI) throw new Error('pytest adapter tests need python3 >= 3.9 in CI');
if (!hasPython) console.warn('Skipping pytest adapter tests: no python3 >= 3.9 on PATH.');

/** `rule@line` for an inline pytest file (line 1 is the first line of `src`). */
function hits(src: string, file = 'tests/test_widget.py'): string[] {
  return auditSource(file, src).map((f) => `${f.ruleId}@${f.line}`);
}

describe.skipIf(!hasPython)('pytest adapter: fixture project', () => {
  const result = audit({ paths: ['fixtures/python-project'], cwd: ROOT });
  const byFile = (dir: string) =>
    result.findings.filter((f) => f.file === `fixtures/python-project/tests/${dir}/test_pricing.py`).map((f) => `${f.ruleId}@${f.line}`);

  it('finds every planted smell in the AI-style tests', () => {
    expect(byFile('bad')).toEqual([
      'tautological-assertion@12',
      'no-assertions@15',
      'never-failing-assertion@20',
      'swallowed-assertion@25',
      'catch-only-assertion@34',
      'asserts-on-mock@39',
      'asserts-on-own-literal@44',
      'mocked-unit-under-test@47',
      'never-failing-assertion@55',
      'never-failing-assertion@60',
      'conditional-assertion@66',
      'skipped-test@70',
      'tautological-assertion@75',
    ]);
  });

  it('has no findings on the honest tests and counts tests like pytest collects them', () => {
    expect(byFile('good')).toEqual([]);
    expect(result.filesScanned).toBe(2);
    expect(result.testsScanned).toBe(20);
    expect(result.unsupported).toEqual([]);
    expect(result.summary.suspiciousTests).toBe(10);
  });

  it('names class-based tests pytest-style and points at the def line', () => {
    const r = audit({ paths: ['fixtures/python-project/tests/good'], cwd: ROOT });
    expect(r.findings).toEqual([]);
    const f = result.findings.find((x) => x.ruleId === 'no-assertions')!;
    expect(f).toMatchObject({ file: 'fixtures/python-project/tests/bad/test_pricing.py', line: 15, column: 1, test: 'test_applies_discount', evidence: 'def test_applies_discount():' });
  });
});

describe.skipIf(!hasPython)('pytest adapter: assertions', () => {
  it('maps plain asserts, yoda conditions and chained comparisons', () => {
    const src = [
      'def test_a():',
      '    assert 3 == add(1, 2)',
      '    assert 0 <= len(items())',
      '    assert 1 <= count() <= 2',
      '    r = add(1, 2)',
      '    assert r == r',
    ].join('\n');
    expect(hits(src)).toEqual(['never-failing-assertion@3', 'tautological-assertion@6']);
  });

  it('treats comparing two fresh objects as a real __eq__ / caching check', () => {
    const src = ['def test_eq():', '    assert Style(bold=True) == Style(bold=True)', '    assert get_req("a") is get_req("a")'].join('\n');
    expect(hits(src)).toEqual([]);
  });

  it('recognizes unittest, pytest.raises, mock assertion methods and asserting helpers', () => {
    const src = [
      'import unittest',
      'import pytest',
      'from unittest.mock import Mock',
      'def check_total(x):',
      '    assert x > 0',
      'class TestCart(unittest.TestCase):',
      '    def test_equal(self):',
      '        self.assertEqual(total([1]), 1)',
      '    def test_raises(self):',
      '        with self.assertRaises(ValueError):',
      '            total(None)',
      'def test_pytest_raises():',
      '    with pytest.raises(ValueError):',
      '        total(None)',
      'def test_mock_interaction():',
      '    cb = Mock()',
      '    run(cb)',
      '    cb.assert_called_once_with(1)',
      'def test_helper():',
      '    check_total(total([2]))',
      'def test_library_helper():',
      '    np.testing.assert_array_equal(total([2]), [2])',
      'def test_fail():',
      '    pytest.fail("todo")',
      'def test_nothing():',
      '    total([1])',
    ].join('\n');
    expect(hits(src)).toEqual(['no-assertions@25']);
  });

  it('flags tuple asserts, fake mock assertions and assertions on constants', () => {
    const src = [
      'def test_a(m):',
      '    assert (total() == 3, "message")',
      '    assert m.called_once_with(1)',
      '    assert m.has_calls',
      '    assert True',
      '    assert m.called',
    ].join('\n');
    expect(hits(src)).toEqual(['never-failing-assertion@2', 'never-failing-assertion@3', 'never-failing-assertion@4', 'tautological-assertion@5']);
  });

  it('flags asserting on a literal the test built, but not one passed to code', () => {
    const src = [
      'def test_own():',
      '    cfg = {"service": "s3", "tags": ["a"]}',
      '    assert cfg["service"] == "s3"',
      '    assert cfg["tags"][0] == "a"',
      'def test_passed():',
      '    cfg = {"service": "s3"}',
      '    client = connect(cfg)',
      '    assert cfg["service"] == "s3"',
      'def test_mutated():',
      '    cfg = {"service": "s3"}',
      '    cfg["service"] = normalize("S3")',
      '    assert cfg["service"] == "s3"',
      'def test_missing_key():',
      '    cfg = {"service": "s3"}',
      '    assert cfg["region"] == "eu"',
    ].join('\n');
    expect(hits(src)).toEqual(['asserts-on-own-literal@3', 'asserts-on-own-literal@4']);
  });

  it('flags snapshot-only tests (syrupy, pytest-snapshot, pytest-regressions)', () => {
    const src = [
      'def test_syrupy(snapshot):',
      '    assert render() == snapshot',
      'def test_both(snapshot):',
      '    out = render()',
      '    assert out == snapshot',
      '    assert out.startswith("<")',
      'def test_regression(data_regression):',
      '    data_regression.check(render())',
    ].join('\n');
    expect(hits(src)).toEqual(['snapshot-only@1', 'snapshot-only@7']);
  });

  it('reports UTF-8 columns in characters, not bytes', () => {
    const [f] = auditSource('tests/test_u.py', 'def test_u():\n    x = "é"; assert x == x\n');
    expect(f).toMatchObject({ ruleId: 'tautological-assertion', line: 2, column: 14 }); // byte offset would be 15
  });
});

describe.skipIf(!hasPython)('pytest adapter: control flow', () => {
  it('flags assertions swallowed by except AssertionError/Exception or contextlib.suppress', () => {
    const src = [
      'import contextlib',
      'def test_a():',
      '    try:',
      '        assert total() == 3',
      '    except Exception:',
      '        pass',
      'def test_b():',
      '    with contextlib.suppress(AssertionError):',
      '        assert total() == 3',
      'def test_narrow_except():',
      '    try:',
      '        assert parse("x") == 1',
      '    except KeyError:',
      '        pass',
      'def test_either_or():',
      '    try:',
      '        assert lines == by_int',
      '    except AssertionError:',
      '        assert lines == by_str',
    ].join('\n');
    expect(hits(src)).toEqual(['swallowed-assertion@4', 'swallowed-assertion@9']);
  });

  it('flags catch-only assertions unless the try is sure to raise or fails otherwise', () => {
    const src = [
      'import pytest',
      'def test_catch_only():',
      '    try:',
      '        parse("x")',
      '    except ValueError as e:',
      '        assert "x" in str(e)',
      'def test_else_fail():',
      '    try:',
      '        parse("x")',
      '    except ValueError as e:',
      '        assert "x" in str(e)',
      '    else:',
      '        pytest.fail("no error")',
      'def test_assert_false():',
      '    try:',
      '        parse("x")',
      '        assert False, "should raise"',
      '    except ValueError as e:',
      '        assert "x" in str(e)',
      'def test_sure_to_raise():',
      '    def boom():',
      '        return 1 / 0',
      '    try:',
      '        boom()',
      '    except ZeroDivisionError:',
      '        assert capture() == "ZeroDivisionError"',
    ].join('\n');
    expect(hits(src)).toEqual(['catch-only-assertion@6']);
  });

  it('flags guarded assertions but not exhaustive branches, search loops or parametrized expectations', () => {
    const src = [
      'import pytest',
      'from contextlib import nullcontext',
      'def test_guarded():',
      '    r = find()',
      '    if r:',
      '        assert r.ok',
      'def test_all_branches(flag):',
      '    if flag:',
      '        assert run(flag) == 1',
      '    else:',
      '        assert run(flag) == 0',
      'def test_search():',
      '    for item in listing():',
      '        if item.name == "x":',
      '            assert item.size == 3',
      '            break',
      '    else:',
      '        pytest.fail("x not listed")',
      'def test_param_warning(warn):',
      '    with pytest.warns(UserWarning) if warn else nullcontext():',
      '        run(warn)',
    ].join('\n');
    expect(hits(src)).toEqual(['conditional-assertion@6']);
  });

  it('reads skip markers but leaves conditional skips and xfail alone', () => {
    const src = [
      'import pytest, unittest, sys',
      '@pytest.mark.skip(reason="later")',
      'def test_a():',
      '    assert run() == 1',
      '@unittest.skip("later")',
      'def test_b():',
      '    assert run() == 1',
      'def test_c():',
      '    pytest.skip("not yet")',
      '@pytest.mark.skipif(sys.platform == "win32", reason="posix")',
      'def test_d():',
      '    assert run() == 1',
      '@pytest.mark.xfail',
      'def test_e():',
      '    assert run() == 2',
      '@pytest.fixture',
      'def test_data():',
      '    return 1',
    ].join('\n');
    expect(hits(src)).toEqual(['skipped-test@3', 'skipped-test@6', 'skipped-test@8']);
  });
});

describe.skipIf(!hasPython)('pytest adapter: mocks', () => {
  it('flags asserting on what a configured Mock returns', () => {
    const src = [
      'from unittest.mock import Mock, MagicMock',
      'def test_a():',
      '    get = Mock(return_value=3)',
      '    assert get() == 3',
      'def test_b():',
      '    api = MagicMock()',
      '    api.fetch.return_value = {"id": 1}',
      '    r = api.fetch()',
      '    assert r == {"id": 1}',
      'def test_c():',
      '    api = MagicMock()',
      '    api.fetch.return_value = {"id": 1}',
      '    assert load_user(api) == {"id": 1}',
    ].join('\n');
    expect(hits(src)).toEqual(['asserts-on-mock@4', 'asserts-on-mock@9']);
  });

  it('flags patching the unit the test then calls, but not patching its dependencies', () => {
    const src = [
      'from unittest.mock import patch',
      'from app import pricing',
      '@patch("app.pricing.fetch_rate", return_value=2)',
      'def test_uses_rate(rate):',
      '    assert pricing.convert(10) == 20',
      'def test_replaces_unit():',
      '    with patch.object(pricing, "convert", return_value=20):',
      '        assert pricing.convert(10) == 20',
    ].join('\n');
    expect(hits(src, 'tests/test_pricing.py')).toEqual(['mocked-unit-under-test@7']);
    expect(hits(src, 'tests/test_other.py')).toEqual([]);
  });

  it('counts mocks per test for excessive-mocking and ignores plain state patches', () => {
    const one = (n: number, name: string) => [`def ${name}(mocker, monkeypatch):`, ...Array.from({ length: n }, (_, i) => `    mocker.patch("app.dep${i}.fn")`), '    assert run() == 1'];
    expect(hits([...one(4, 'test_a'), ...one(4, 'test_b')].join('\n'))).toEqual([]);
    expect(hits(one(5, 'test_a').join('\n'))).toEqual(['excessive-mocking@2']);
    expect(auditSource('tests/test_w.py', one(5, 'test_a').join('\n'))[0]).toMatchObject({ column: 1, test: 'test_a', message: expect.stringContaining('test_a mocks 5 modules') });
    // Class-level patches apply to every method, like a file-level vi.mock.
    const cls = [...Array.from({ length: 5 }, (_, i) => `@patch("app.dep${i}.fn")`), 'class TestA:', '    def test_a(self, *mocks):', '        assert run() == 1'];
    expect(auditSource('tests/test_w.py', ['from unittest.mock import patch', ...cls].join('\n'))).toMatchObject([
      { ruleId: 'excessive-mocking', line: 2, column: 1, message: 'Mocks 5 modules — little real code is left under test.' },
    ]);
    const state = ['def test_s(monkeypatch):', ...Array.from({ length: 5 }, (_, i) => `    monkeypatch.setattr(app, "FLAG${i}", False)`), '    assert run() == 1'];
    expect(hits(state.join('\n'))).toEqual([]);
  });
});

describe.skipIf(!hasPython)('pytest adapter: robustness and safety', () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HONEST_TESTS_PYTHON;
    resetPythonLookup();
  });

  it('reports syntax errors per file without losing the rest of the batch', () => {
    dir = mkdtempSync(join(tmpdir(), 'ht-py-'));
    writeFileSync(join(dir, 'test_ok.py'), 'def test_ok():\n    run()\n');
    writeFileSync(join(dir, 'test_broken.py'), 'def test_broken(:\n');
    const r = audit({ paths: [dir], cwd: dir });
    expect(r.parseErrors).toEqual([{ file: 'test_broken.py', message: expect.stringContaining('SyntaxError') }]);
    expect(r.findings.map((f) => `${f.file}:${f.ruleId}`)).toEqual(['test_ok.py:no-assertions']);
  });

  it('counts asserting helpers from test-support files (conftest.py, tests/lib)', () => {
    dir = mkdtempSync(join(tmpdir(), 'ht-py-'));
    mkdirSync(join(dir, 'tests', 'lib'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'lib', '__init__.py'), 'class Result:\n    def did_create(self, p):\n        assert p in self.files\n');
    writeFileSync(join(dir, 'tests', 'test_install.py'), 'def test_a(script):\n    script.run("x").did_create("y")\ndef test_b(script):\n    script.run("x")\n');
    const r = audit({ paths: [dir], cwd: dir });
    expect(r.findings.map((f) => `${f.test}:${f.ruleId}`)).toEqual(['test_b:no-assertions']);
  });

  it('never imports modules from the audited directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'ht-py-'));
    const marker = join(dir, 'imported');
    for (const mod of ['json', 'ast', 're', 'sys', 'sitecustomize']) {
      writeFileSync(join(dir, `${mod}.py`), `open(${JSON.stringify(marker)}, "w").write("${mod}")\n`);
    }
    writeFileSync(join(dir, 'test_x.py'), 'import json\ndef test_x():\n    assert json.loads("1") == 1\n');
    const r = audit({ paths: [dir], cwd: dir });
    expect(r.filesScanned).toBe(1);
    expect(existsSync(marker)).toBe(false);
  });

  it('reports Python files as unsupported, with the reason, when no interpreter is available', () => {
    dir = mkdtempSync(join(tmpdir(), 'ht-py-'));
    writeFileSync(join(dir, 'test_x.py'), 'def test_x():\n    pass\n');
    process.env.HONEST_TESTS_PYTHON = join(dir, 'no-such-python');
    resetPythonLookup();
    const r = audit({ paths: [dir], cwd: dir });
    expect(r.filesScanned).toBe(0);
    expect(r.unsupported).toEqual([{ file: 'test_x.py', language: 'python', reason: expect.stringContaining('Python 3.9+') }]);
  });
});
