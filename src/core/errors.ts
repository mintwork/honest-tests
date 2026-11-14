/** An adapter can't run in this environment (e.g. no Python interpreter); its files are reported as unsupported. */
export class AdapterUnavailableError extends Error {}
