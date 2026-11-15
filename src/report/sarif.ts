import { isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AuditResult } from '../core/engine.js';
import type { Rule, Severity } from '../core/types.js';
import type { MutationReport } from '../mutate/runner.js';

/**
 * SARIF 2.1.0 for GitHub code scanning (`github/codeql-action/upload-sarif`) and other SARIF viewers.
 * Paths are relative to `%SRCROOT%` (the directory honest-tests ran in), so run it from the repo root.
 */

const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const INFO_URI = 'https://github.com/mintwork/honest-tests';
const RULES_URI = `${INFO_URI}#rules`;
const MUTANT_RULE = 'surviving-mutant';

const LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = { error: 'error', warning: 'warning', info: 'note' };
/** Code scanning shows non-security alerts by `problem.severity`. */
const PROBLEM_SEVERITY: Record<Severity, string> = { error: 'error', warning: 'warning', info: 'recommendation' };

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  help: { text: string; markdown: string };
  helpUri: string;
  defaultConfiguration: { level: 'error' | 'warning' | 'note' };
  properties: { tags: string[]; precision: string; 'problem.severity': string };
}

function pascal(id: string): string {
  return id.replace(/(^|-)([a-z0-9])/g, (_, __, ch: string) => ch.toUpperCase());
}

function sarifRule(id: string, severity: Severity, description: string, fix: string): SarifRule {
  return {
    id,
    name: pascal(id),
    shortDescription: { text: description },
    fullDescription: { text: description },
    help: { text: `Fix: ${fix}`, markdown: `**Fix:** ${fix}\n\nSee the [honest-tests rules](${RULES_URI}).` },
    helpUri: RULES_URI,
    defaultConfiguration: { level: LEVEL[severity] },
    properties: { tags: ['tests', 'test-quality'], precision: severity === 'error' ? 'high' : 'medium', 'problem.severity': PROBLEM_SEVERITY[severity] },
  };
}

function location(file: string, line: number, column: number) {
  const uri = isAbsolute(file) ? pathToFileURL(file).href : file.split('/').map(encodeURIComponent).join('/');
  return {
    physicalLocation: {
      artifactLocation: isAbsolute(file) ? { uri } : { uri, uriBaseId: 'SRCROOT' },
      region: { startLine: Math.max(1, line), startColumn: Math.max(1, column) },
    },
  };
}

export function toSarif(audit: AuditResult | null, mutation: MutationReport | null, rules: Rule[], version: string, cwd: string): string {
  const used = new Set(audit?.findings.map((f) => f.ruleId) ?? []);
  const driverRules: SarifRule[] = rules.filter((r) => audit !== null || used.has(r.id)).map((r) => sarifRule(r.id, r.severity, r.description, r.fix));
  const survivors = mutation?.mutants.filter((m) => m.status === 'survived') ?? [];
  if (mutation) {
    driverRules.push(
      sarifRule(
        MUTANT_RULE,
        'warning',
        'A mutation of this line (an operator, constant or return value changed) did not make any test fail.',
        'Add an assertion that fails for the mutated behavior — usually an exact value or a boundary case — or explain why the mutant is equivalent.',
      ),
    );
  }
  const ruleIndex = new Map(driverRules.map((r, i) => [r.id, i]));

  const results = [
    ...(audit?.findings ?? []).map((f) => ({
      ruleId: f.ruleId,
      ruleIndex: ruleIndex.get(f.ruleId),
      level: LEVEL[f.severity],
      message: { text: `${f.message}${f.test ? ` (test: "${f.test}")` : ''}` },
      locations: [location(f.file, f.line, f.column)],
      properties: { evidence: f.evidence, fix: f.fix, ...(f.test ? { test: f.test } : {}), ...(f.change ? { change: f.change } : {}) },
    })),
    ...survivors.map((m) => ({
      ruleId: MUTANT_RULE,
      ruleIndex: ruleIndex.get(MUTANT_RULE),
      level: 'warning' as const,
      message: { text: `Mutant survived: ${m.description}. No test failed when this line was changed.` },
      locations: [location(m.file, m.line, m.column)],
      properties: { operator: m.operator, original: m.original, replacement: m.replacement },
    })),
  ];

  const sarif = {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'honest-tests', semanticVersion: version, informationUri: INFO_URI, rules: driverRules } },
        originalUriBaseIds: { SRCROOT: { uri: pathToFileURL(cwd.endsWith(sep) ? cwd : cwd + sep).href } },
        results,
        ...(audit?.parseErrors.length
          ? {
              invocations: [
                {
                  executionSuccessful: true,
                  toolExecutionNotifications: audit.parseErrors.map((p) => ({
                    level: 'warning',
                    message: { text: `Could not parse: ${p.message}` },
                    locations: [location(p.file, 1, 1)],
                  })),
                },
              ],
            }
          : {}),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}
