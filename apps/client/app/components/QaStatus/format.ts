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
