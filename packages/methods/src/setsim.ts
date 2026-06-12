/**
 * Shared set-similarity primitive.
 *
 * `jaccardAtLeast` was independently duplicated in getTokenLargestAccounts.ts
 * and getSignaturesForAddress.ts. Extracted here so the SIMILARITY methods
 * (those two, plus getVoteAccounts and getRecentPerformanceSamples) share one
 * implementation. Two sets "agree" when |A∩B| / |A∪B| ≥ threshold; two empty
 * sets agree.
 */

export function jaccardAtLeast<T>(a: Set<T>, b: Set<T>, threshold: number): boolean {
  if (a.size === 0 && b.size === 0) return true;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  if (union === 0) return true;
  return inter / union >= threshold;
}
