import type { ColorPaletteProp } from '@mui/joy/styles';
import type { GitHubLakeConnectionStatus } from '@bike4mind/common';

// API-free on purpose, like driveConnectionDisplay.ts: a structural subset of LakeGitHubConnection.
type DescribableGitHubConnection = {
  status: GitHubLakeConnectionStatus;
  enabled: boolean;
  lastError: string | null;
  repositoryFullName: string;
  syncStale: boolean;
  disconnecting: boolean;
};

/**
 * Chip wording for a lake's GitHub connection. Labels match describeDriveConnection's
 * (driveConnectionDisplay.ts) so both sources read the same, including its key subtlety: a sync
 * that stopped short heals back to 'connected' but keeps its lastError, and is not a healthy sync.
 */
export function describeGitHubConnection(connection: DescribableGitHubConnection): {
  label: string;
  title: string;
  color: ColorPaletteProp;
} {
  const repo = connection.repositoryFullName;
  const detail = connection.lastError ? ` - ${connection.lastError}` : '';

  // Checked before `enabled`: a pending disconnect is also disabled, but is not an archive pause.
  if (connection.disconnecting) {
    return {
      label: 'Disconnecting',
      title: `Disconnecting the GitHub repository ${repo} and removing its files`,
      color: 'warning',
    };
  }
  if (!connection.enabled) {
    return { label: 'Paused', title: `Syncing ${repo} is paused while the lake is archived`, color: 'neutral' };
  }
  // Access lost is its own chip: a re-sync cannot fix it until the user restores access on GitHub.
  if (connection.status === 'access_lost') {
    return {
      label: 'Access lost',
      title: `GitHub repository ${repo}: the App can no longer read it${detail}. Fix access on GitHub, then re-sync.`,
      color: 'danger',
    };
  }
  // 'error' stays re-syncable (claimForSync admits it), so the copy offers a retry before a reconnect.
  if (connection.status === 'error') {
    return {
      label: 'Sync failed',
      title: `GitHub repository ${repo}: sync failed${detail}. Re-sync to retry, or reconnect if access was removed.`,
      color: 'danger',
    };
  }
  if (connection.status === 'syncing' && connection.syncStale) {
    return {
      label: 'Sync stalled',
      title: `GitHub repository ${repo}: the last sync stopped responding. Re-sync to restart it.`,
      color: 'warning',
    };
  }
  // A run is in flight, so any lastError belongs to the previous one.
  if (connection.status === 'syncing') {
    return { label: 'Syncing', title: `Sync in progress for the GitHub repository ${repo}`, color: 'primary' };
  }
  if (connection.lastError) {
    return {
      label: 'Stopped short',
      title: `GitHub repository ${repo}: last sync stopped short${detail}`,
      color: 'warning',
    };
  }
  if (connection.status === 'connected') {
    return { label: 'Connected', title: `Syncing the GitHub repository ${repo}`, color: 'success' };
  }
  // A status newer than this client (a server deployed ahead of it) must not read as healthy.
  const unknownStatus: never = connection.status;
  return {
    label: 'Unknown',
    title: `GitHub repository ${repo}: unrecognized status ${String(unknownStatus)}`,
    color: 'warning',
  };
}

type ProgressableGitHubConnection = Pick<DescribableGitHubConnection, 'status' | 'syncStale'> & {
  fileCount: number;
  candidateCount: number | null;
};

/**
 * A live sync's progress: files indexed so far against the files the sync rules admitted from the
 * tree. Null when no sync is running. `percent` is null until the sync has read the tree, and is
 * capped at 100 because a changed file's old copy is retired only after its new one lands.
 */
export function describeGitHubSyncProgress(
  connection: ProgressableGitHubConnection
): { indexed: number; total: number | null; percent: number | null } | null {
  if (connection.status !== 'syncing' || connection.syncStale) return null;
  const total = connection.candidateCount || null;
  const percent = total === null ? null : Math.min(100, Math.round((connection.fileCount / total) * 100));
  return { indexed: connection.fileCount, total, percent };
}
