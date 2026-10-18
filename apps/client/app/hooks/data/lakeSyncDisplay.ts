import { relativeTimeFormat } from '@client/app/utils/dateUtils';

// API-free on purpose, like driveConnectionDisplay.ts: structural subsets of the connection DTOs.

/**
 * A failed run stamps lastPolledAt too (releaseSyncClaim), and only a clean one clears lastError, so
 * with an error on record the time is the last attempt rather than the last sync.
 */
export function describeDriveLastSync({
  lastPolledAt,
  lastError,
}: {
  lastPolledAt: string | null;
  lastError: string | null;
}): string {
  if (!lastPolledAt) return 'Not synced yet';
  return `${lastError ? 'Last sync attempt' : 'Last synced'} ${relativeTimeFormat(new Date(lastPolledAt))}`;
}

/** lastSyncedAt is stamped on success only, so it is always a real sync time. */
export function describeGitHubLastSync({ lastSyncedAt }: { lastSyncedAt: string | null }): string {
  return lastSyncedAt ? `Last synced ${relativeTimeFormat(new Date(lastSyncedAt))}` : 'Not synced yet';
}
