import type { ModuleMock, RawFinding, Rule } from '../core/types.js';

export const EXCESSIVE_MOCK_THRESHOLD = 5;

export const excessiveMocking: Rule = {
  id: 'excessive-mocking',
  severity: 'warning',
  description: `File mocks ${EXCESSIVE_MOCK_THRESHOLD}+ modules — the test mostly exercises mocks wired to each other.`,
  fix: 'Mock at the system boundary (HTTP, DB, clock) and let internal modules run for real, or split the unit so it needs fewer collaborators.',
  check(file) {
    // Re-mocking the same module in several tests (vi.doMock per case) is still one collaborator.
    const distinct = (mocks: ModuleMock[]) => [...new Set(mocks.map((m) => m.specifier))];
    const fileLevel = file.moduleMocks.filter((m) => m.scope === undefined);
    const specs = distinct(fileLevel);
    if (specs.length >= EXCESSIVE_MOCK_THRESHOLD) {
      return [{ line: fileLevel[0]!.line, column: 1, evidence: specs.join(', '), message: `Mocks ${specs.length} modules — little real code is left under test.` }];
    }
    // Mocks confined to one test (pytest `@patch`, `with patch(...)`) only count for that test.
    const scopes = new Map<string, ModuleMock[]>();
    for (const m of file.moduleMocks) if (m.scope !== undefined) scopes.set(m.scope, [...(scopes.get(m.scope) ?? []), m]);
    const out: RawFinding[] = [];
    for (const [scope, mocks] of scopes) {
      const all = distinct([...fileLevel, ...mocks]);
      if (all.length < EXCESSIVE_MOCK_THRESHOLD) continue;
      out.push({ line: mocks[0]!.line, column: 1, evidence: all.join(', '), test: scope, message: `${scope} mocks ${all.length} modules — little real code is left under test.` });
    }
    return out;
  },
};
