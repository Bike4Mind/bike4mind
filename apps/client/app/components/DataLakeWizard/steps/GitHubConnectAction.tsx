import { Box, Button, Chip, CircularProgress, Stack, Tooltip, Typography } from '@mui/joy';
import GitHubIcon from '@mui/icons-material/GitHub';
import SyncIcon from '@mui/icons-material/Sync';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  useDisconnectLakeGitHub,
  useLakeGitHubConnection,
  useLakeGitHubCanManage,
  useResyncLakeGitHub,
  type LakeGitHubConnection,
} from '@client/app/hooks/data/githubLake';
import { useBeginLakeGitHubConnect } from '@client/app/hooks/data/useBeginLakeGitHubConnect';
import { describeGitHubConnection } from '@client/app/hooks/data/githubConnectionDisplay';
import { getServerErrorField } from '@client/app/utils/error';

/**
 * Why re-sync is off right now, or undefined when it can run. Mirrors sync.ts's 409s, including its
 * admitting a 'syncing' row whose claim went stale (syncStale), which nothing else would ever reset.
 * 'error' stays re-syncable on purpose: claimForSync admits it so a re-sync can retry once access is restored.
 */
function resyncBlockedReason(connection: LakeGitHubConnection): string | undefined {
  if (!connection.enabled) return 'This connection is paused while the lake is archived.';
  if (connection.status === 'syncing' && !connection.syncStale) return 'A sync is already running.';
  return undefined;
}

/**
 * Connect a GitHub repository to an EXISTING org data lake, then show its sync status, re-sync and
 * disconnect. Connecting leaves the app for GitHub's OAuth authorize page; the
 * GitHubLakeCallbackPage route exchanges the return and opens the repository picker to finish it.
 * Create mode has no lake id to sign into the flow, so it is not offered there.
 *
 * Callers gate this on EnableDataLakeGitHub and canConnectLakeDrive (org + manage), as for Drive.
 */
export default function GitHubConnectAction({ lake }: { lake: { id: string } }) {
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const { data: connection, isLoading, isError } = useLakeGitHubConnection(lake.id);
  const canManage = useLakeGitHubCanManage(lake.id).data ?? true;
  const { begin: beginConnect, isPending: connecting } = useBeginLakeGitHubConnect(lake.id);
  const resync = useResyncLakeGitHub();
  const disconnect = useDisconnectLakeGitHub();

  if (isLoading) {
    return <CircularProgress size="sm" data-testid="github-connection-loading" />;
  }

  if (isError || (!connection && !canManage)) {
    // Same as DriveConnectAction: the read admits an appointed org admin, but connecting is owner/manager only.
    return (
      <Tooltip title="GitHub connect is available to organization owners/managers on an organization data lake.">
        <span>
          <Button
            data-testid="github-connect-unavailable-btn"
            variant="outlined"
            color="neutral"
            startDecorator={<GitHubIcon />}
            disabled
          >
            Connect GitHub
          </Button>
        </span>
      </Tooltip>
    );
  }

  if (!connection) {
    return (
      <Stack gap={0.5}>
        <Button
          data-testid="github-connect-btn"
          variant="outlined"
          color="neutral"
          startDecorator={<GitHubIcon />}
          loading={connecting}
          onClick={beginConnect}
          sx={{ alignSelf: 'flex-start' }}
        >
          Connect GitHub
        </Button>
        <Typography level="body-xs" sx={{ color: 'text.tertiary' }} data-testid="github-access-disclosure">
          Read-only access. You&apos;ll approve the GitHub App, then pick the repository here.
        </Typography>
      </Stack>
    );
  }

  const { label, color } = describeGitHubConnection(connection);
  const blockedReason = resyncBlockedReason(connection);

  return (
    <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" data-testid="github-connection-status">
      <GitHubIcon />
      <Typography level="body-sm">
        <strong>{connection.repositoryFullName}</strong>
        {connection.defaultBranch && ` @ ${connection.defaultBranch}`}
      </Typography>
      <Chip size="sm" variant="soft" color={color} data-testid="github-connection-status-chip">
        {label}
      </Chip>
      {/* A pending disconnect is disabled too, so the archive-pause tooltip would misread it. */}
      {canManage && !connection.disconnecting && (
        <Tooltip title={blockedReason ?? ''} disableHoverListener={!blockedReason}>
          <span>
            <Button
              data-testid="github-resync-btn"
              size="sm"
              variant="outlined"
              color="neutral"
              startDecorator={<SyncIcon />}
              loading={resync.isPending}
              disabled={!!blockedReason}
              onClick={() =>
                resync.mutate(lake.id, {
                  onSuccess: () => toast.success(`Re-syncing ${connection.repositoryFullName}...`),
                  onError: (e: unknown) =>
                    toast.error(getServerErrorField(e) || 'Could not start a re-sync. Please try again.'),
                })
              }
            >
              Re-sync
            </Button>
          </span>
        </Tooltip>
      )}
      {connection.disconnecting && (
        <Typography level="body-xs" data-testid="github-disconnecting-note" sx={{ flexBasis: '100%' }}>
          {connection.fileCount === 0
            ? 'Finishing disconnect...'
            : `Removing ${connection.fileCount} remaining file${connection.fileCount === 1 ? '' : 's'} in the background.`}
        </Typography>
      )}
      {canManage &&
        (confirmingDisconnect ? (
          <>
            <Typography
              level="body-xs"
              color="danger"
              data-testid="github-disconnect-warning"
              sx={{ flexBasis: '100%' }}
            >
              Disconnecting permanently deletes the {connection.fileCount} file{connection.fileCount === 1 ? '' : 's'}{' '}
              this repository synced into the data lake.
            </Typography>
            <Button
              data-testid="github-disconnect-confirm-btn"
              size="sm"
              variant="soft"
              color="danger"
              startDecorator={<LinkOffIcon />}
              loading={disconnect.isPending}
              onClick={() =>
                disconnect.mutate(lake.id, {
                  onSuccess: () => {
                    setConfirmingDisconnect(false);
                    toast.success(
                      `Disconnecting ${connection.repositoryFullName}. Its files are being removed in the background.`
                    );
                  },
                  // Surfaces the 409 "a sync is in progress" so the user knows to retry later.
                  onError: (e: unknown) =>
                    toast.error(getServerErrorField(e) || 'Could not disconnect. Please try again.'),
                })
              }
            >
              Confirm disconnect
            </Button>
            <Button
              data-testid="github-disconnect-cancel-btn"
              size="sm"
              variant="plain"
              color="neutral"
              disabled={disconnect.isPending}
              onClick={() => setConfirmingDisconnect(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            data-testid="github-disconnect-btn"
            size="sm"
            variant="plain"
            color="danger"
            startDecorator={<LinkOffIcon />}
            // The route declines to re-queue a purge that is still progressing, so only offer a retry
            // once it looks stalled.
            disabled={connection.disconnecting && !connection.disconnectStalled}
            onClick={() => setConfirmingDisconnect(true)}
          >
            {!connection.disconnecting
              ? 'Disconnect'
              : connection.disconnectStalled
                ? 'Retry disconnect'
                : 'Disconnecting'}
          </Button>
        ))}
      {connection.lastError && (
        <Box sx={{ flexBasis: '100%' }}>
          <Typography level="body-xs" color={color} data-testid="github-connection-last-error">
            {connection.lastError}
          </Typography>
        </Box>
      )}
    </Stack>
  );
}
