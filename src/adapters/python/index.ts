import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdapterUnavailableError } from '../../core/errors.js';
import type { LanguageAdapter, TestFileModel } from '../../core/types.js';

/**
 * pytest adapter.
 *
 * Test files are parsed by `extract.py` with Python's own `ast` module (no regexes, no third-party
 * parser) and mapped to the language-neutral `TestFileModel`:
 *   - `def test_*` (incl. async, parametrized) and `Test*` / `unittest.TestCase` methods -> TestCase
 *   - `assert a == b`, `assert x`, `assert x is None`, `pytest.raises`, `self.assertEqual`,
 *     `m.assert_called_once_with` -> Assertion (matcherKind 'equal' | 'truthy' | 'null' | 'throws' | 'called' ...)
 *   - `@pytest.mark.skip`, `@unittest.skip`, a leading `pytest.skip()` -> modifier 'skip'
 *   - `patch('pkg.unit.fn')` / `mocker.patch` / `patch.object` / `monkeypatch.setattr` -> ModuleMock
 *   - `Mock(return_value=x)` / `m.return_value = x` / `side_effect` -> MockSetup { configuresReturn: true }
 *
 * Safety: the audited code is never imported or run. Sources go to the extractor on stdin, and Python
 * starts isolated (`-I -S`) in the temp dir, so nothing in the audited repo can shadow `ast`/`json`.
 */

const SCRIPT = fileURLToPath(new URL('./extract.py', import.meta.url));

let cachedPython: string | null | undefined;

/** `$HONEST_TESTS_PYTHON`, else the first of python3 / python that is Python 3.9+. */
function findPython(): string | null {
  if (cachedPython !== undefined) return cachedPython;
  const candidates = process.env.HONEST_TESTS_PYTHON ? [process.env.HONEST_TESTS_PYTHON] : ['python3', 'python'];
  cachedPython = null;
  for (const bin of candidates) {
    const r = spawnSync(bin, ['-I', '-S', '-c', 'import sys; print(sys.version_info >= (3, 9))'], { cwd: tmpdir(), encoding: 'utf8', timeout: 10_000 });
    if (r.status === 0 && r.stdout.trim() === 'True') {
      cachedPython = bin;
      break;
    }
  }
  return cachedPython;
}

/** Test hook: forget the interpreter lookup (e.g. after changing HONEST_TESTS_PYTHON). */
export function resetPythonLookup() {
  cachedPython = undefined;
}

const SUPPORT_ROOTS = new Set(['test', 'tests', 'testing']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.tox', '.nox', 'build', 'dist', 'site-packages']);
const MAX_SUPPORT_FILES = 2000;

const isPyTest = (p: string) => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(p.replace(/\\/g, '/'));

/**
 * Non-test Python files in the test tree (conftest.py, tests/lib/*.py, helpers.py): functions there
 * that assert are assertion helpers (`result.did_create(path)`), so calling them counts as asserting.
 * The test tree is the nearest `test`/`tests`/`testing` directory above each test file.
 */
function supportSources(testPaths: string[]): string[] {
  const roots = new Set<string>();
  for (const p of testPaths) {
    let dir = dirname(p);
    let root = dir;
    for (let i = 0; i < 6; i++) {
      if (SUPPORT_ROOTS.has(basename(dir))) {
        root = dir;
        break;
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    roots.add(root);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (dir: string) => {
    if (out.length >= MAX_SUPPORT_FILES || seen.has(dir)) return;
    seen.add(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) visit(full);
      } else if (e.isFile() && extname(e.name) === '.py' && !isPyTest(full) && out.length < MAX_SUPPORT_FILES) {
        try {
          if (statSync(full).size < 1_000_000) out.push(readFileSync(full, 'utf8'));
        } catch {
          /* unreadable: skip */
        }
      }
    }
  };
  for (const r of roots) visit(r);
  return out;
}

type Extracted = Omit<TestFileModel, 'file' | 'language' | 'lines'> | { error: string };

export function parsePythonTestFiles(files: Array<{ path: string; source: string }>): Array<TestFileModel | Error> {
  if (files.length === 0) return [];
  const python = findPython();
  if (!python) {
    throw new AdapterUnavailableError('needs Python 3.9+ on PATH (python3), or set HONEST_TESTS_PYTHON');
  }
  const r = spawnSync(python, ['-I', '-S', SCRIPT], {
    cwd: tmpdir(),
    input: JSON.stringify({ files, support: supportSources(files.map((f) => f.path)) }),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
    timeout: 10 * 60_000,
  });
  if (r.status !== 0) {
    throw new Error(`pytest extractor failed (exit ${r.status ?? r.signal}): ${(r.stderr || String(r.error ?? '')).trim().slice(0, 500)}`);
  }
  const out = JSON.parse(r.stdout) as Extracted[];
  return out.map((m, i) => {
    const { path, source } = files[i]!;
    if ('error' in m) return new Error(m.error);
    return { file: path, language: 'python', lines: source.split(/\r?\n/), ...m };
  });
}

export const pythonAdapter: LanguageAdapter = {
  id: 'python',
  extensions: ['.py'],
  isTestFile: isPyTest,
  parseTestFile(path: string, source: string): TestFileModel {
    const [model] = parsePythonTestFiles([{ path, source }]);
    if (model instanceof Error) throw model;
    return model!;
  },
  parseTestFiles: parsePythonTestFiles,
};
