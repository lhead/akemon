/** Eisenhower sort: smaller quadrant number first */
export function sortByQuadrant<T extends { quadrant: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.quadrant - b.quadrant);
}

/** Dedup by type+id composite key, preserving first occurrence */
export function dedupeWorkItems<T extends { type: string; id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter(it => {
    const key = `${it.type}:${it.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Retry intervals for order execution failures */
export const RETRY_INTERVALS = [0, 30_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000] as const;

/**
 * Returns next retry delay in ms given the current retry count, or null if exhausted.
 * count=0 → first retry (0ms). count=intervals.length → null (give up).
 */
export function computeRetryDelay(count: number, intervals: readonly number[] = RETRY_INTERVALS): number | null {
  if (count < 0 || count >= intervals.length) return null;
  return intervals[count];
}
