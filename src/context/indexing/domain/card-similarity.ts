/**
 * Similarity of two card sides for edit detection: 1 − levenshtein(x, y) / max(|x|, |y|), on text
 * trimmed and with whitespace runs collapsed to one space (case and accents count). Lengths are in
 * code points. Two sides are similar when that is ≥ 0.8, i.e. distance ≤ ⌊max / 5⌋.
 */
export const normalizeSide = (side: string) => side.trim().replace(/\s+/g, ' ');

/** Sides longer than this (normalized, in code points) are never compared by distance. */
export const MAX_COMPARED_LENGTH = 1000;
/** Matrix cells one meter (one note sync) may compute; a banded comparison costs |x| · (2k + 1). */
export const CELL_BUDGET = 20_000_000;

/** `similar` answers true, false, or null when the bounds above do not allow deciding. */
export class SimilarityMeter {
  private budget = CELL_BUDGET;

  similar(x: string, y: string): boolean | null {
    const a = Array.from(normalizeSide(x)), b = Array.from(normalizeSide(y));
    const max = Math.max(a.length, b.length);
    const k = Math.floor(max / 5);
    if (max - Math.min(a.length, b.length) > k) return false; // the length difference alone exceeds k
    if (max > MAX_COMPARED_LENGTH) return null;
    const cost = (a.length + 1) * (2 * k + 1);
    if (cost > this.budget) return null;
    this.budget -= cost;
    return boundedDistance(a, b, k) <= k;
  }
}

/** Levenshtein distance restricted to the diagonal band |i − j| ≤ k; any result > k means "more than k". */
export function boundedDistance(a: string[], b: string[], k: number): number {
  const n = a.length, m = b.length, far = k + 1;
  if (Math.abs(n - m) > k) return far;
  let prev = new Int32Array(m + 1).fill(far), cur = new Int32Array(m + 1).fill(far);
  for (let j = 0; j <= Math.min(m, k); j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    const lo = Math.max(1, i - k), hi = Math.min(m, i + k);
    cur[lo - 1] = lo === 1 && i <= k ? i : far;
    let best = cur[lo - 1];
    for (let j = lo; j <= hi; j++) {
      const v = Math.min(prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), prev[j] + 1, cur[j - 1] + 1, far);
      cur[j] = v;
      if (v < best) best = v;
    }
    if (hi < m) cur[hi + 1] = far;
    if (best > k) return far;
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}
