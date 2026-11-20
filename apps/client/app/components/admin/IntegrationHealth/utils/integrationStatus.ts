import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import type { IntegrationDashboardEntry } from '../types';

export type IntegrationStatusView = { tone: AdminStatusTone; label: string };

export const NOT_CHECKED: IntegrationStatusView = { tone: 'neutral', label: 'Not checked' };

const STATUS_VIEW: Record<IntegrationDashboardEntry['status'], IntegrationStatusView> = {
  healthy: { tone: 'good', label: 'Healthy' },
  degraded: { tone: 'warn', label: 'Degraded' },
  unhealthy: { tone: 'bad', label: 'Down' },
  no_data: NOT_CHECKED,
};

/** The one rule for "has been probed": a readable timestamp. A missing or unreadable one counts as never. */
export function lastCheckedTime(lastCheckedAt: string | null): number | null {
  const time = lastCheckedAt ? new Date(lastCheckedAt).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

/** 'no_data' or no readable last check both show as not checked, so the chip agrees with the "Never checked" text. */
export function integrationStatusView(entry: Pick<IntegrationDashboardEntry, 'status' | 'lastCheckedAt'>) {
  if (lastCheckedTime(entry.lastCheckedAt) === null) return NOT_CHECKED;
  return STATUS_VIEW[entry.status];
}

/** "never" when `lastCheckedTime` finds no check, else "42s ago", "5m ago", "3h ago", "2d ago". */
export function formatLastChecked(lastCheckedAt: string | null, now: number = Date.now()): string {
  const time = lastCheckedTime(lastCheckedAt);
  if (time === null) return 'never';
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
