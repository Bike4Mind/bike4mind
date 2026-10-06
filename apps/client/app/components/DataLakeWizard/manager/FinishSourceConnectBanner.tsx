import { Alert, Button, Stack, Typography } from '@mui/joy';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useLakeGitHubConnection } from '@client/app/hooks/data/githubLake';
import { useLakeDriveConnection } from '@client/app/hooks/data/googleDrive';
import { useBeginLakeGitHubConnect } from '@client/app/hooks/data/useBeginLakeGitHubConnect';
import { useLakeDriveFolderConnect } from '@client/app/hooks/data/useLakeDriveFolderConnect';
import {
  getLakeSource,
  resolveLakeSourceAvailability,
  type LakeSource,
  type LakeSourceKind,
} from '@client/app/components/datalake/lakeSources';
import DriveAccessDisclosure from '../steps/DriveAccessDisclosure';
import type { DataLakeOrigin, DataLakePendingConnector } from '@bike4mind/common';

type FinishSourceConnectLake = {
  id: string;
  organizationId?: string | null;
  origin?: DataLakeOrigin;
  pendingConnector?: DataLakePendingConnector;
  canManage?: boolean;
  isCreator?: boolean;
};

const PICKED_THING: Record<LakeSourceKind, string> = { github: 'repository', googleDrive: 'folder' };

/**
 * The way back into an abandoned connect (cancelled at the provider, picker closed, grant expired):
 * an empty connector-fed org lake with no source attached. Targets the connector the lake was created
 * for (`pendingConnector`); an absent or unrecognized value falls back to GitHub.
 *
 * Shown only once both connection reads have resolved to "none": a failed or in-flight read, a bound
 * Drive folder or GitHub repository, or any file in the lake hides it. The reads, not
 * `pendingConnector`, decide "no source", because clearing that field on bind is best-effort
 * server-side.
 */
export default function FinishSourceConnectBanner({
  lake,
  fileCount,
}: {
  lake: FinishSourceConnectLake;
  fileCount: number | undefined;
}) {
  const { isAdminFeatureEnabled } = useFeatureEnabled();
  const source = getLakeSource(lake.pendingConnector === 'googleDrive' ? 'googleDrive' : 'github');
  const eligible =
    !!lake.organizationId &&
    lake.origin === 'connector-fed' &&
    resolveLakeSourceAvailability(source, lake, isAdminFeatureEnabled).status === 'available';

  // A bound repository still owns the lake with EnableDataLakeGitHub off (assertLakeConnectorFree is
  // flag-free), but its read route 403s then, so "no GitHub source" cannot be confirmed: stay hidden.
  const gitHubFlag = isAdminFeatureEnabled('EnableDataLakeGitHub');
  const gitHub = useLakeGitHubConnection(lake.id, eligible && gitHubFlag);
  const drive = useLakeDriveConnection(lake.id, eligible);

  const gitHubNone = gitHubFlag && gitHub.isSuccess && gitHub.data === null;
  const hasNoSource = gitHubNone && drive.isSuccess && drive.data === null;
  if (!eligible || !hasNoSource || fileCount !== 0) return null;

  const { kind, label, Icon } = source;
  return (
    <Alert
      color="primary"
      variant="soft"
      startDecorator={<Icon />}
      data-testid={`${kind}-finish-connect-banner-${lake.id}`}
      sx={{ mb: 1 }}
    >
      <Stack gap={0.5} sx={{ flex: 1 }}>
        <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
          <Typography level="body-sm" sx={{ flex: 1, minWidth: 200 }}>
            No source is connected to this lake yet. Finish connecting {label} to pick the {PICKED_THING[kind]} that
            feeds it.
          </Typography>
          {kind === 'googleDrive' ? (
            <FinishDriveButton lakeId={lake.id} source={source} />
          ) : (
            <FinishGitHubButton lakeId={lake.id} source={source} />
          )}
        </Stack>
        {kind === 'googleDrive' && <DriveAccessDisclosure />}
      </Stack>
    </Alert>
  );
}

// One component per source so a lake only mounts the connect hooks of the source it targets.
function FinishGitHubButton({ lakeId, source }: { lakeId: string; source: LakeSource }) {
  const { begin, isPending } = useBeginLakeGitHubConnect(lakeId);
  return <FinishButton lakeId={lakeId} source={source} loading={isPending} onClick={begin} />;
}

function FinishDriveButton({ lakeId, source }: { lakeId: string; source: LakeSource }) {
  const { openFolderPicker, isPicking, isConnecting } = useLakeDriveFolderConnect(lakeId);
  return (
    <FinishButton lakeId={lakeId} source={source} loading={isPicking || isConnecting} onClick={openFolderPicker} />
  );
}

function FinishButton({
  lakeId,
  source: { kind, label, Icon },
  loading,
  onClick,
}: {
  lakeId: string;
  source: LakeSource;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="sm"
      data-testid={`${kind}-finish-connect-btn-${lakeId}`}
      startDecorator={<Icon />}
      loading={loading}
      onClick={onClick}
    >
      Finish connecting {label}
    </Button>
  );
}
