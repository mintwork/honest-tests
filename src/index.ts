export { audit, auditSource, discoverTestFiles, type AuditOptions, type AuditResult, type ChangeSummary } from './core/engine.js';
export { changedFiles, parseUnifiedDiff, GitError, type ChangedFiles, type ChangedLines } from './core/git.js';
export { toSarif } from './report/sarif.js';
export { mutate, MutationError, type MutateOptions, type MutationReport, type MutantResult } from './mutate/runner.js';
export { rules } from './rules/index.js';
export { adapters, adapterFor } from './adapters/index.js';
export { generateJsMutants, applyMutant } from './adapters/js/mutants.js';
export type * from './core/types.js';
