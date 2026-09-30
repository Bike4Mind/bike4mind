import { Box, Button, Chip, CircularProgress, Stack, Tooltip, Typography } from '@mui/joy';
import GitHubIcon from '@mui/icons-material/GitHub';
import SyncIcon from '@mui/icons-material/Sync';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  useDisconnectLakeGitHub,
  useLakeGitHubConnection,
  useResyncLakeGitHub,
  useStartLakeGitHubConnect,
  type LakeGitHubConnection,
} from '@client/app/hooks/data/githubLake';
import { describeGitHubConnection } from '@client/app/hooks/data/githubConnectionDisplay';
import { saveGitHubLakeConnectHandoff } from '@client/app/utils/githubLakeConnectHandoff';

/** The specific server `error` message off an axios failure, if the response carried one. */
function serverError(e: unknown): string | undefined {
  return (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
}

/** Why re-sync is off right now, or undefined when it can run. Mirrors sync.ts's 409s. */
function resyncBlockedReason(connection: LakeGitHubConnection): string | undefined {
  if (connection.status === 'error')
    return 'The GitHub App lost access to this repository. Disconnect and connect again.';
  if (!connection.enabled) return 'This connection is paused while the lake is archived.';
  if (connection.status === 'syncing') return 'A sync is already running.';
  return undefined;
}

/**
 * Connect a GitHub repository to an EXISTING org data lake, then show its sync status, re-sync and
 * disconnect. Connecting leaves the app for GitHub's install page; the GitHubLakeCallbackPage
 * route finishes it. Create mode has no lake id to sign into the flow, so it is not offered there.
 *
 * Callers gate this on EnableDataLakeGitHub and canConnectLakeDrive (org + manage), as for Drive.
 */
export default function GitHubConnectAction({ lake }: { lake: { id: string } }) {
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  const { data: connection, isLoading, isError } = useLakeGitHubConnection(lake.id);
  const startConnect = useStartLakeGitHubConnect();
  const resync = useResyncLakeGitHub();
  const disconnect = useDisconnectLakeGitHub();

  const beginConnect = () =>
    startConnect.mutate(lake.id, {
      onSuccess: ({ installUrl, authorizeUrl }) => {
        try {
          saveGitHubLakeConnectHandoff({ dataLakeId: lake.id, authorizeUrl });
        } catch {
          // Without the handoff the callback cannot finish an already-installed account's connect.
          toast.error('Could not start the GitHub connection: this browser blocked session storage.');
          return;
        }
        setRedirecting(true);
        window.location.assign(installUrl);
      },
      // e.g. "is curated, change its origin", "already connected to a Google Drive folder".
      onError: (e: unknown) =>
        toast.error(serverError(e) || 'Could not start the GitHub connection. Please try again.'),
    });

  if (isLoading) {
    return <CircularProgress size="sm" data-testid="github-connection-loading" />;
  }

  if (isError) {
    // Same steady state as DriveConnectAction: the read needs org owner/manager, narrower than canManage.
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
          loading={startConnect.isPending || redirecting}
          onClick={beginConnect}
          sx={{ alignSelf: 'flex-start' }}
        >
          Connect GitHub
        </Button>
        <Typography level="body-xs" sx={{ color: 'text.tertiary' }} data-testid="github-access-disclosure">
          Read-only access to one repository. On GitHub, choose &quot;Only select repositories&quot; and pick it.
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
                onError: (e: unknown) => toast.error(serverError(e) || 'Could not start a re-sync. Please try again.'),
              })
            }
          >
            Re-sync
          </Button>
        </span>
      </Tooltip>
      {confirmingDisconnect ? (
        <>
          <Typography level="body-xs" color="danger" data-testid="github-disconnect-warning" sx={{ flexBasis: '100%' }}>
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
                  toast.success(`Disconnected ${connection.repositoryFullName}.`);
                },
                // Surfaces the 409 "a sync is in progress" so the user knows to retry later.
                onError: (e: unknown) => toast.error(serverError(e) || 'Could not disconnect. Please try again.'),
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
          onClick={() => setConfirmingDisconnect(true)}
        >
          Disconnect
        </Button>
      )}
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
