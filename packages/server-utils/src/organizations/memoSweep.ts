// Long-lived self-host processes keep the alert evaluators loaded, so their per-process memos
// drop expired entries once a map grows.
export const MEMO_SWEEP_SIZE = 1000;
/** Minimum gap between sweeps of one map (ms), so a map full of live entries is not rescanned per call. */
export const MEMO_SWEEP_INTERVAL_MS = 30_000;

const lastSweepAt = new WeakMap<Map<string, unknown>, number>();

export function sweepExpiredMemo<V>(map: Map<string, V>, now: number, expiresAt: (value: V) => number): void {
  if (map.size < MEMO_SWEEP_SIZE) return;
  const last = lastSweepAt.get(map);
  if (last !== undefined && now - last < MEMO_SWEEP_INTERVAL_MS) return;
  lastSweepAt.set(map, now);
  for (const [key, value] of map) if (expiresAt(value) <= now) map.delete(key);
}
