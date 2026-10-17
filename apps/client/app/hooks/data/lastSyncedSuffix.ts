import { relativeTimeFormat } from '@client/app/utils/dateUtils';

/**
 * The " - last synced 18 minutes ago" tail of an idle chip tooltip. Empty when the caller does not
 * supply the field; null means the connection has never synced.
 */
export function lastSyncedSuffix(lastSyncedAt: string | Date | null | undefined): string {
  if (lastSyncedAt === undefined) return '';
  if (!lastSyncedAt) return ' - not synced yet';
  const at = new Date(lastSyncedAt);
  if (Number.isNaN(at.getTime())) return '';
  // Clock skew can put the stamp ahead of this browser; never read it as "in 3 minutes".
  return ` - last synced ${relativeTimeFormat(new Date(Math.min(at.getTime(), Date.now())))}`;
}
