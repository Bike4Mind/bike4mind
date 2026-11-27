export function resolveCheckedAt(finishedAt?: string, startedAt?: string, now: Date = new Date()): Date {
  for (const raw of [finishedAt, startedAt]) {
    const ms = raw ? Date.parse(raw) : NaN;
    if (!Number.isNaN(ms)) return new Date(Math.min(ms, now.getTime()));
  }
  return now;
}
