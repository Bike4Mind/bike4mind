import { LinearProgress, Stack, Typography } from '@mui/joy';
import { describeGitHubSyncProgress } from '@client/app/hooks/data/githubConnectionDisplay';
import type { LakeGitHubConnection } from '@client/app/hooks/data/githubLake';

/**
 * "N of M files indexed" and a bar for a running sync, determinate once the sync has read the tree.
 * Renders nothing when no sync is running. The counts come from the connection poll, which runs fast
 * while a sync is live (gitHubConnectionPollInterval).
 */
export default function GitHubLakeSyncProgress({ connection }: { connection: LakeGitHubConnection }) {
  const progress = describeGitHubSyncProgress(connection);
  if (!progress) return null;
  const { indexed, total, percent } = progress;

  return (
    <Stack gap={0.5} sx={{ width: '100%' }} data-testid="github-sync-progress">
      <Typography level="body-xs" sx={{ color: 'text.tertiary' }} data-testid="github-sync-progress-count">
        {total === null ? `${indexed} file${indexed === 1 ? '' : 's'} indexed` : `${indexed} of ${total} files indexed`}
      </Typography>
      <LinearProgress
        size="sm"
        determinate={percent !== null}
        value={percent ?? undefined}
        aria-label="Sync progress"
        data-testid="github-sync-progress-bar"
        data-percent={percent ?? undefined}
      />
    </Stack>
  );
}
