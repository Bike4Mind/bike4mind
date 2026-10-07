const pad = (n: number) => String(n).padStart(2, '0');

/** 252000 -> "4m12s"; 45000 -> "45s"; 3720000 -> "1h02m". */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m`;
}

/** Local "HH:MM" for today, "Mon D HH:MM" otherwise. */
export function formatTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

/** "Core . staging (tenant-a)": one state key (QaStateKey in server/qa/streak.ts). */
export function stateLabel(k: { suite: string; env: string; tenant?: string }): string {
  return `${k.suite} . ${k.env}${k.tenant ? ` (${k.tenant})` : ''}`;
}

/** Test-scale durations: 640 -> "640ms"; 1234 -> "1.2s"; 45000 -> "45s". */
export function formatTestDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 9950) return `${(ms / 1000).toFixed(1)}s`;
  return formatDuration(ms);
}

/** Signed difference: formatDelta(40_000, formatDuration) -> "+40s". */
export function formatDelta(ms: number, format: (ms: number) => string): string {
  return `${ms < 0 ? '-' : '+'}${format(Math.abs(ms))}`;
}

/** A test this much slower than its median (>= +50%) is flagged. */
export const SLOW_TEST_RATIO = 1.5;

/** https://github.com/<owner>/<repo>/commit/<sha>, derived from an Actions run URL; undefined for any other URL. */
export function commitUrl(ciRunUrl: string, sha: string): string | undefined {
  const repo = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/actions\/runs\//.exec(ciRunUrl)?.[1];
  return repo && sha ? `${repo}/commit/${sha}` : undefined;
}
