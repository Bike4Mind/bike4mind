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
    { key: 'drive', label: 'Drive', text: drive ? describeDriveLastSync(drive) : null },
    { key: 'github', label: 'GitHub', text: gitHubEnabled && gitHub ? describeGitHubLastSync(gitHub) : null },
  ].filter((line): line is { key: string; label: string; text: string } => !!line.text);
  if (lines.length === 0) return null;
  // One source per lake is enforced only for new bindings, so a lake bound earlier can carry both.
  const labelled = lines.length > 1;

  return (
    <Stack data-testid={`datalake-last-synced-${lakeId}`} sx={{ alignSelf: 'center' }}>
      {lines.map(({ key, label, text }) => (
        <Typography key={key} level="body-xs" sx={{ color: 'text.tertiary' }}>
          {labelled ? `${label}: ${text}` : text}
        </Typography>
      ))}
    </Stack>
  );
}
