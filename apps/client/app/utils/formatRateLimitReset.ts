/**
 * Short "3h 12m" / "45m" / "30s" until an epoch-seconds reset; empty if absent
 * or already past. `nowMs` is injectable so tests can pin the clock.
 */
export function formatRateLimitReset(resetAtSeconds?: number, nowMs: number = Date.now()): string {
  if (!resetAtSeconds) return '';
  const remainingSeconds = resetAtSeconds - Math.floor(nowMs / 1000);
  if (remainingSeconds <= 0) return '';
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${remainingSeconds}s`;
}
