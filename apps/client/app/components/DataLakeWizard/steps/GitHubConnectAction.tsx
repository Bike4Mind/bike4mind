import { Button, Chip, CircularProgress, Link, Sheet, Stack, Tooltip, Typography } from '@mui/joy';
import GitHubIcon from '@mui/icons-material/GitHub';
import SyncIcon from '@mui/icons-material/Sync';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import { useState } from 'react';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import { acceptsConnectorContent } from '@bike4mind/common';
import {
  useDisconnectLakeGitHub,
  useLakeGitHubConnection,
  useLakeGitHubCanManage,
  useResyncLakeGitHub,
  type LakeGitHubConnection,
} from '@client/app/hooks/data/githubLake';
import { useBeginLakeGitHubConnect } from '@client/app/hooks/data/useBeginLakeGitHubConnect';
import { useUpdateDataLake } from '@client/app/hooks/data/dataLakes';
import { describeGitHubConnection } from '@client/app/hooks/data/githubConnectionDisplay';
import { getServerErrorField } from '@client/app/utils/error';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';
import GitHubLakeSyncProgress from '@client/app/components/datalake/GitHubLakeSyncProgress';
import GitHubLakeSyncRulesModal from '@client/app/components/datalake/GitHubLakeSyncRulesModal';
import StartLakeChatButton from '@client/app/components/datalake/StartLakeChatButton';
import type { LakeSourcePanelLake } from '@client/app/components/datalake/lakeSources';

const SHORT_SHA_LENGTH = 7;

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
 * Offered once a sync has landed files: the first sync finished, or a later one is refreshing files
 * that are already askable. A first sync still running has not finished landing the repo.
 */
export function canAskAboutRepo(connection: LakeGitHubConnection): boolean {
  if (connection.disconnecting || connection.fileCount === 0) return false;
  return !!connection.lastSyncedAt || connection.status !== 'syncing';
}

/**
 * Last synced time and commit, "N files synced, M skipped" with the skip count opening the sync rules,
 * and a running sync's progress.
 */
function GitHubSyncSummary({ connection }: { connection: LakeGitHubConnection }) {
  const [rulesOpen, setRulesOpen] = useState(false);
  const { lastSyncedAt, lastSyncedCommitSha, repositoryFullName, fileCount, skippedCount } = connection;

  return (
    <Stack gap={0.25}>
      <Typography level="body-xs" sx={{ color: 'text.tertiary' }} data-testid="github-connection-last-synced">
        {lastSyncedAt ? `Last synced ${relativeTimeFormat(new Date(lastSyncedAt))}` : 'Not synced yet'}
        {lastSyncedAt && lastSyncedCommitSha && (
          <>
            {' at '}
            <Link
              href={`https://github.com/${repositoryFullName}/commit/${lastSyncedCommitSha}`}
              target="_blank"
              rel="noopener noreferrer"
              level="body-xs"
              sx={{ fontFamily: 'code' }}
              data-testid="github-connection-commit-link"
            >
              {lastSyncedCommitSha.slice(0, SHORT_SHA_LENGTH)}
            </Link>
          </>
        )}
      </Typography>
      <Typography level="body-xs" data-testid="github-connection-counts">
        {`${fileCount} file${fileCount === 1 ? '' : 's'} synced, `}
        <Link
          component="button"
          level="body-xs"
          onClick={() => setRulesOpen(true)}
          data-testid="github-sync-rules-link"
        >
          {skippedCount === null ? 'see sync rules' : `${skippedCount} skipped`}
        </Link>
      </Typography>
      <GitHubLakeSyncProgress connection={connection} />
      <GitHubLakeSyncRulesModal open={rulesOpen} onClose={() => setRulesOpen(false)} />
    </Stack>
  );
}

/**
 * Connect a GitHub repository to an EXISTING org data lake, then show it as the lake's source card:
 * sync status, last synced commit, counts, re-sync, disconnect, and "Ask about this repo" once synced. Connecting leaves the app for GitHub's OAuth authorize page; the
 * GitHubLakeCallbackPage route exchanges the return and opens the repository picker to finish it.
 * Create mode has no lake id to sign into the flow, so it is not offered there.
 *
 * Callers gate this on EnableDataLakeGitHub and canConnectLakeDrive (org + manage), as for Drive.
 *
 * The start route refuses a lake that is not connector-fed (githubLakeConnection.ts), so a curated or
 * unknown origin asks to switch it first; an absent origin reads as curated, the stored default.
 */
export default function GitHubConnectAction({ lake }: { lake: LakeSourcePanelLake }) {
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  // Keyed by lake: the header reuses this instance across lake selections, so a prompt opened on one
  // lake must not stay open (and confirm) on the next.
  const [switchPromptLakeId, setSwitchPromptLakeId] = useState<string | null>(null);
  const confirmingSwitch = switchPromptLakeId === lake.id;

  const { data: connection, isLoading, isError } = useLakeGitHubConnection(lake.id);
  const canManage = useLakeGitHubCanManage(lake.id).data === true;
  const { begin: beginConnect, isPending: connecting } = useBeginLakeGitHubConnect(lake.id);
  const resync = useResyncLakeGitHub();
  const disconnect = useDisconnectLakeGitHub();
  const updateLake = useUpdateDataLake({ notifySuccess: false });
  const needsSwitch = !acceptsConnectorContent(lake.origin);

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
          loading={connecting && !confirmingSwitch}
          disabled={confirmingSwitch}
          onClick={() => (needsSwitch ? setSwitchPromptLakeId(lake.id) : beginConnect())}
          sx={{ alignSelf: 'flex-start' }}
        >
          Connect GitHub
        </Button>
        {confirmingSwitch && (
          <Stack gap={0.5} data-testid="github-switch-origin-prompt">
            <Typography level="body-sm">Switch this lake to connector-fed to connect a repository?</Typography>
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
              This applies to the whole lake: any connector or scheduled import can then add files to it, not just
              GitHub.
            </Typography>
            <Stack direction="row" gap={1}>
              <Button
                data-testid="github-switch-origin-confirm-btn"
                size="sm"
                variant="soft"
                color="primary"
                loading={updateLake.isPending || connecting}
                onClick={() => {
                  const lakeId = lake.id;
                  // The update hook toasts its own failure; the connect only starts once the origin is written.
                  updateLake.mutate(
                    { id: lakeId, origin: 'connector-fed' },
                    {
                      onSuccess: () => {
                        setSwitchPromptLakeId(null);
                        // Undo the switch if the start is refused, so a failed connect does not leave the
                        // lake connector-fed with nothing connected. Abandoning GitHub's page keeps it: the
                        // user confirmed the switch, and the lake's origin chip shows it. A 409 means another
                        // connector (or someone else's connect) holds the lake, which needs connector-fed.
                        beginConnect({
                          onFailed: error => {
                            if (isAxiosError(error) && error.response?.status === 409) return;
                            updateLake.mutate({ id: lakeId, origin: 'curated' });
                          },
                        });
                      },
                    }
                  );
                }}
              >
                Switch and connect
              </Button>
              <Button
                data-testid="github-switch-origin-cancel-btn"
                size="sm"
                variant="plain"
                color="neutral"
                disabled={updateLake.isPending || connecting}
                onClick={() => setSwitchPromptLakeId(null)}
              >
                Cancel
              </Button>
            </Stack>
          </Stack>
        )}
        <Typography level="body-xs" sx={{ color: 'text.tertiary' }} data-testid="github-access-disclosure">
          Read-only access. You&apos;ll approve the GitHub App, then pick the repository here.
        </Typography>
      </Stack>
    );
  }

  const { label, color } = describeGitHubConnection(connection);
  const blockedReason = resyncBlockedReason(connection);

  return (
    <Sheet
      variant="outlined"
      data-testid="github-connection-status"
      sx={{ borderRadius: 'sm', p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}
    >
      <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
        <GitHubIcon />
        <Typography level="body-sm" sx={{ overflowWrap: 'anywhere' }}>
          <strong>{connection.repositoryFullName}</strong>
          {connection.defaultBranch && ` @ ${connection.defaultBranch}`}
        </Typography>
        <Chip size="sm" variant="soft" color={color} data-testid="github-connection-status-chip">
          {label}
        </Chip>
      </Stack>
      <GitHubSyncSummary connection={connection} />
      <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
        {canAskAboutRepo(connection) && (
          <StartLakeChatButton
            lake={lake}
            startDecorator={<ChatBubbleOutlineIcon sx={{ fontSize: 16 }} />}
            testId="github-ask-about-repo-btn"
          >
            Ask about this repo
          </StartLakeChatButton>
        )}
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
      </Stack>
      {connection.lastError && (
        <Typography level="body-xs" color={color} data-testid="github-connection-last-error">
          {connection.lastError}
        </Typography>
      )}
    </Sheet>
  );
}
