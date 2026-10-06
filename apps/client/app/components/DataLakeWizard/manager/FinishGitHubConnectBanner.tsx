import { Alert, Button, Stack, Typography } from '@mui/joy';
import GitHubIcon from '@mui/icons-material/GitHub';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useLakeGitHubCanManage, useLakeGitHubConnection } from '@client/app/hooks/data/githubLake';
import { useLakeDriveConnection } from '@client/app/hooks/data/googleDrive';
import { useBeginLakeGitHubConnect } from '@client/app/hooks/data/useBeginLakeGitHubConnect';
import { canConnectLakeDrive } from '@client/app/components/datalake/lakeVisibility';
import type { DataLakeOrigin } from '@bike4mind/common';

type FinishGitHubConnectLake = {
  id: string;
  organizationId?: string | null;
  origin?: DataLakeOrigin;
  canManage?: boolean;
  isCreator?: boolean;
};

/**
 * The way back into an abandoned GitHub connect (cancelled at GitHub, picker closed, grant expired):
 * an empty connector-fed org lake with no source attached. Restarts the same connect as
 * GitHubConnectAction - the held grant lives server-side behind an httpOnly nonce, so whether the
 * picker could simply reopen is not knowable here, and a re-authorize is a pass-through once the
 * App is approved.
 *
 * Shown only once both connection reads have resolved to "none" and the caller may connect (an
 * appointed org admin can read the status but the connect route is owner/manager only): a failed or
 * in-flight read, a Drive folder, or any file in the lake hides it. It does not read the lake's `pendingConnector` yet, so an
 * empty connector-fed lake still waiting on a Drive connect shows it too.
 */
export default function FinishGitHubConnectBanner({
  lake,
  fileCount,
}: {
  lake: FinishGitHubConnectLake;
  fileCount: number | undefined;
}) {
  const { isAdminFeatureEnabled } = useFeatureEnabled();
  const eligible =
    !!lake.organizationId &&
    lake.origin === 'connector-fed' &&
    canConnectLakeDrive(lake) &&
    isAdminFeatureEnabled('EnableDataLakeGitHub');

  const gitHub = useLakeGitHubConnection(lake.id, eligible);
  const drive = useLakeDriveConnection(lake.id, eligible);
  const canConnect = useLakeGitHubCanManage(lake.id, eligible).data === true;
  const { begin, isPending } = useBeginLakeGitHubConnect(lake.id);

  const hasNoSource = gitHub.isSuccess && gitHub.data === null && drive.isSuccess && drive.data === null;
  if (!eligible || !canConnect || !hasNoSource || fileCount !== 0) return null;

  return (
    <Alert
      color="primary"
      variant="soft"
      startDecorator={<GitHubIcon />}
      data-testid={`github-finish-connect-banner-${lake.id}`}
      sx={{ mb: 1 }}
    >
      <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap" sx={{ flex: 1 }}>
        <Typography level="body-sm" sx={{ flex: 1, minWidth: 200 }}>
          No source is connected to this lake yet. Finish connecting GitHub to pick the repository that feeds it.
        </Typography>
        <Button
          size="sm"
          data-testid={`github-finish-connect-btn-${lake.id}`}
          startDecorator={<GitHubIcon />}
          loading={isPending}
          onClick={begin}
        >
          Finish connecting GitHub
        </Button>
      </Stack>
    </Alert>
  );
}
