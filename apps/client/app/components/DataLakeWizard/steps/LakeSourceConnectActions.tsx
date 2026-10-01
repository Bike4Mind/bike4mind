import { Stack } from '@mui/joy';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useLakeDriveConnection } from '@client/app/hooks/data/googleDrive';
import { useLakeGitHubConnection } from '@client/app/hooks/data/githubLake';
import DriveConnectAction from './DriveConnectAction';
import GitHubConnectAction from './GitHubConnectAction';

/**
 * The connect/status control for every external source an EXISTING org lake can take. A lake is fed
 * by one connector (resolveConnectableLake 409s a second), so once either source is connected only
 * that one is shown; until then every enabled source offers its connect button.
 *
 * Callers gate on canConnectLakeDrive (org + manage). GitHub additionally sits behind
 * EnableDataLakeGitHub, without which its routes 403 - so its query does not even fire.
 */
export default function LakeSourceConnectActions({ lake }: { lake: { id: string } }) {
  const { isAdminFeatureEnabled } = useFeatureEnabled();
  const gitHubEnabled = isAdminFeatureEnabled('EnableDataLakeGitHub');

  // Shared query keys with the actions below, so these reads are deduped rather than doubled.
  const { data: driveConnection } = useLakeDriveConnection(lake.id);
  const { data: gitHubConnection } = useLakeGitHubConnection(lake.id, gitHubEnabled);

  // With the flag off the GitHub query never fires, so stale cache must not hide Drive.
  const showDrive = !gitHubEnabled || !gitHubConnection;
  const showGitHub = gitHubEnabled && !driveConnection;

  return (
    <Stack gap={1} data-testid="lake-source-connect-actions">
      {showDrive && <DriveConnectAction lake={lake} />}
      {showGitHub && <GitHubConnectAction lake={lake} />}
    </Stack>
  );
}
