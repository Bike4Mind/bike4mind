import { Alert, Button, Stack, Tooltip, Typography } from '@mui/joy';
import GitHubIcon from '@mui/icons-material/GitHub';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import type { LakeGitHubConnection } from '@client/app/hooks/data/githubLake';

/**
 * What a lake shows once the data-lake GitHub App has lost its read on the bound repository: the App
 * was uninstalled, or the repository left its "Only select repositories" selection. Offers the two
 * ways out - repair the access on GitHub, or drop the source - in place of the Re-sync the plain
 * error state offers, which cannot succeed until the access itself is restored.
 *
 * Disconnect is delegated: the caller owns the confirm-then-delete sequence (and its file-count
 * warning), so this state cannot start a purge the surrounding component does not know about.
 */
export default function GitHubAccessLostState({
  connection,
  onDisconnect,
  disconnectDisabled,
}: {
  connection: LakeGitHubConnection;
  onDisconnect: () => void;
  disconnectDisabled?: boolean;
}) {
  const { fixAccessUrl, repositoryFullName, accountLogin } = connection;

  return (
    <Alert
      color="danger"
      variant="soft"
      startDecorator={<GitHubIcon />}
      data-testid="github-access-lost-state"
      sx={{ alignItems: 'flex-start' }}
    >
      <Stack gap={1} sx={{ flex: 1 }}>
        <Typography level="title-sm" data-testid="github-access-lost-title">
          Access lost to {repositoryFullName}
        </Typography>
        <Typography level="body-xs" data-testid="github-access-lost-detail">
          The GitHub App can no longer read this repository, so it has stopped syncing. Either the App was uninstalled
          from {accountLogin}, or the repository was removed from the repositories it may access. Files already in the
          lake are untouched.
        </Typography>
        <Stack direction="row" gap={1} flexWrap="wrap">
          {/* Targeted at the account's installation, never its owner-only settings page: GitHub 404s
              that for anyone who does not own the account. An org member lands on a request instead. */}
          <Tooltip
            title={fixAccessUrl ? '' : 'The data-lake GitHub App is not configured on this deployment.'}
            disableHoverListener={!!fixAccessUrl}
          >
            <span>
              <Button
                data-testid="github-access-lost-fix-btn"
                component={fixAccessUrl ? 'a' : 'button'}
                href={fixAccessUrl ?? undefined}
                target={fixAccessUrl ? '_blank' : undefined}
                rel={fixAccessUrl ? 'noopener noreferrer' : undefined}
                disabled={!fixAccessUrl}
                size="sm"
                variant="solid"
                color="danger"
                startDecorator={<GitHubIcon />}
                endDecorator={<OpenInNewIcon fontSize="small" />}
              >
                Fix on GitHub
              </Button>
            </span>
          </Tooltip>
          <Button
            data-testid="github-access-lost-disconnect-btn"
            size="sm"
            variant="plain"
            color="danger"
            startDecorator={<LinkOffIcon />}
            disabled={disconnectDisabled}
            onClick={onDisconnect}
          >
            Disconnect
          </Button>
        </Stack>
        <Typography level="body-xs" sx={{ color: 'text.tertiary' }} data-testid="github-access-lost-resync-hint">
          Once access is restored on GitHub, use Re-sync to pick up where this lake left off.
        </Typography>
      </Stack>
    </Alert>
  );
}
