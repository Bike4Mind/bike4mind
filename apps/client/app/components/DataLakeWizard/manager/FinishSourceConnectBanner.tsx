import { Alert, Button, IconButton, Stack, Typography } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useLakeGitHubConnection } from '@client/app/hooks/data/githubLake';
import { useLakeDriveCanManage, useLakeDriveConnection } from '@client/app/hooks/data/googleDrive';
import { useBeginLakeGitHubConnect } from '@client/app/hooks/data/useBeginLakeGitHubConnect';
import { useLakeDriveFolderConnect } from '@client/app/hooks/data/useLakeDriveFolderConnect';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
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
  hasGitHubConnection?: boolean;
  canManage?: boolean;
  isCreator?: boolean;
};

const PICKED_THING: Record<LakeSourceKind, string> = { github: 'repository', googleDrive: 'folder' };

/**
 * The way back into an abandoned connect (cancelled at the provider, picker closed, grant expired):
 * an empty connector-fed lake (org, or personal for its creator) with no source attached. Targets the
 * connector the lake was created for (`pendingConnector`); an absent or unrecognized value falls back
 * to GitHub.
 *
 * Shown only once both connection reads have resolved to "none" and the caller may connect (an
 * appointed org admin can read the status, but both connect routes are owner/manager only): a failed
 * or in-flight read, a bound Drive folder or GitHub repository, or any file in the lake hides it. The reads, not
 * `pendingConnector`, decide "no source", because clearing that field on bind is best-effort
 * server-side. With EnableDataLakeGitHub off the GitHub read is replaced by the list's
 * `hasGitHubConnection`, and an absent value hides the banner.
 *
 * A GitHub connect the callback page reported as failed or cancelled for this lake swaps the banner
 * for the reason and a Try again. Where the banner would not show, the reason falls back to a toast
 * once the reads settle, and is dropped silently if the lake stops qualifying after it was shown.
 */
export default function FinishSourceConnectBanner({
  lake,
  fileCount,
}: {
  lake: FinishSourceConnectLake;
  fileCount: number | undefined;
}) {
  const { isAdminFeatureEnabled } = useFeatureEnabled();
  const failure = useDataLakeWizardStore(s =>
    s.gitHubConnectFailure?.lakeId === lake.id ? s.gitHubConnectFailure : null
  );
  const setGitHubConnectFailure = useDataLakeWizardStore(s => s.setGitHubConnectFailure);
  const source = getLakeSource(lake.pendingConnector === 'googleDrive' ? 'googleDrive' : 'github');
  const eligible =
    lake.origin === 'connector-fed' &&
    resolveLakeSourceAvailability(source, lake, isAdminFeatureEnabled).status === 'available';

  // A bound repository still owns the lake with EnableDataLakeGitHub off (assertLakeConnectorFree is
  // flag-free), but its read route 403s then, so the list's flag-free hasGitHubConnection stands in.
  const gitHubFlag = isAdminFeatureEnabled('EnableDataLakeGitHub');
  const gitHub = useLakeGitHubConnection(lake.id, eligible && gitHubFlag);
  const drive = useLakeDriveConnection(lake.id, eligible);
  // The Drive read is the one that always fires here, and its flag is the same verdict the GitHub route gives.
  const canConnect = useLakeDriveCanManage(lake.id, eligible).data === true;

  const gitHubNone = gitHubFlag ? gitHub.isSuccess && gitHub.data === null : lake.hasGitHubConnection === false;
  const hasNoSource = gitHubNone && drive.isSuccess && drive.data === null;
  const showBanner = eligible && canConnect && hasNoSource && fileCount === 0;
  // Disabled queries stay pending, so an ineligible lake is settled without its reads.
  const settled = !eligible || ((!gitHubFlag || !gitHub.isPending) && !drive.isPending && fileCount !== undefined);
  const showFailure = !!failure && showBanner && source.kind === 'github';

  const failureShown = useRef(false);
  useEffect(() => {
    if (!failure) return;
    if (showFailure) {
      failureShown.current = true;
      return;
    }
    if (!settled) return;
    if (!failureShown.current) toast.error(failure.message);
    failureShown.current = false;
    setGitHubConnectFailure(null);
  }, [failure, showFailure, settled, setGitHubConnectFailure]);

  if (failure && showFailure) {
    const gitHubSource = getLakeSource('github');
    return (
      <Alert
        color="warning"
        variant="soft"
        startDecorator={<gitHubSource.Icon />}
        endDecorator={
          <IconButton
            size="sm"
            variant="plain"
            color="warning"
            aria-label="Dismiss"
            data-testid={`github-finish-connect-dismiss-btn-${lake.id}`}
            onClick={() => setGitHubConnectFailure(null)}
          >
            <CloseIcon />
          </IconButton>
        }
        data-testid={`github-finish-connect-banner-${lake.id}`}
        sx={{ mb: 1 }}
      >
        <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap" sx={{ flex: 1 }}>
          <Typography
            level="body-sm"
            data-testid={`github-finish-connect-error-${lake.id}`}
            sx={{ flex: 1, minWidth: 200 }}
          >
            {failure.message}
          </Typography>
          <FinishGitHubButton
            lakeId={lake.id}
            source={gitHubSource}
            label="Try again"
            onBegin={() => setGitHubConnectFailure(null)}
          />
        </Stack>
      </Alert>
    );
  }

  if (!showBanner) return null;

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
function FinishGitHubButton({
  lakeId,
  source,
  label,
  onBegin,
}: {
  lakeId: string;
  source: LakeSource;
  label?: string;
  onBegin?: () => void;
}) {
  const { begin, isPending } = useBeginLakeGitHubConnect(lakeId);
  return (
    <FinishButton
      lakeId={lakeId}
      source={source}
      label={label}
      loading={isPending}
      onClick={() => {
        onBegin?.();
        void begin();
      }}
    />
  );
}

function FinishDriveButton({ lakeId, source }: { lakeId: string; source: LakeSource }) {
  const { openFolderPicker, isPicking, isConnecting } = useLakeDriveFolderConnect(lakeId);
  return (
    <FinishButton lakeId={lakeId} source={source} loading={isPicking || isConnecting} onClick={openFolderPicker} />
  );
}

function FinishButton({
  lakeId,
  source: { kind, label: sourceLabel, Icon },
  label = `Finish connecting ${sourceLabel}`,
  loading,
  onClick,
}: {
  lakeId: string;
  source: LakeSource;
  label?: string;
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
      {label}
    </Button>
  );
}
