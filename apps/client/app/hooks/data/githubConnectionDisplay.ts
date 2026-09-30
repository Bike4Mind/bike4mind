import type { ColorPaletteProp } from '@mui/joy/styles';
import type { LakeGitHubConnection } from '@client/app/hooks/data/githubLake';

type DescribableGitHubConnection = Pick<
  LakeGitHubConnection,
  'status' | 'enabled' | 'lastError' | 'repositoryFullName'
>;

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

  if (connection.status === 'error') {
    return { label: 'Needs reconnect', title: `GitHub repository ${repo} lost access${detail}`, color: 'danger' };
  }
  if (!connection.enabled) {
    return { label: 'Paused', title: `Syncing ${repo} is paused while the lake is archived`, color: 'neutral' };
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
