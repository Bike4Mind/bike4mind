import { Stack, Typography } from '@mui/joy';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useLakeDriveConnection } from '@client/app/hooks/data/googleDrive';
import { useLakeGitHubConnection } from '@client/app/hooks/data/githubLake';
import { describeDriveLastSync, describeGitHubLastSync } from '@client/app/hooks/data/lakeSyncDisplay';

/**
 * Header freshness line for a connector-fed lake: "Last synced <time>" per attached source. Reads
 * the same queries, under the same gates, as LakeDriveStatusChip / LakeGitHubStatusChip, so it adds
 * no requests. Renders nothing with no connection, mid-read, or on a failed read.
 */
export default function LakeSyncStatus({
  lakeId,
  organizationId,
  isCreator,
}: {
  lakeId: string;
  /** The lake's org scope; absent for a personal lake. */
  organizationId?: string;
  isCreator: boolean;
}) {
  const { isAdminFeatureEnabled } = useFeatureEnabled();
  const gitHubEnabled = !!organizationId && isAdminFeatureEnabled('EnableDataLakeGitHub');
  const { data: drive } = useLakeDriveConnection(lakeId, !!organizationId || isCreator);
  const { data: gitHub } = useLakeGitHubConnection(lakeId, gitHubEnabled);

  const lines = [
    drive && describeDriveLastSync(drive),
    gitHubEnabled && gitHub && describeGitHubLastSync(gitHub),
  ].filter((line): line is string => !!line);
  if (lines.length === 0) return null;

  return (
    <Stack data-testid={`datalake-last-synced-${lakeId}`}>
      {lines.map(line => (
        <Typography key={line} level="body-xs" sx={{ color: 'text.tertiary' }}>
          {line}
        </Typography>
      ))}
    </Stack>
  );
}
