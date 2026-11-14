// Fixture for the per-test-file coverage map: each function has its own test file.
export const SAMPLE_LIMIT = 1000;

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) {
    return lo;
  }
  return x > hi ? hi : x;
}

export function round(x: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function isOutlier(x: number): boolean {
  return x > SAMPLE_LIMIT;
}
