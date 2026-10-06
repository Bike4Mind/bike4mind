import { useState } from 'react';
import { Alert, Box, Button, Stack, Typography } from '@mui/joy';
import GitHubIcon from '@mui/icons-material/GitHub';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useBeginGitHubLakeCreate } from '@client/app/hooks/data/githubLakeCreate';
import { saveGitHubLakeConnectHandoff } from '@client/app/utils/githubLakeConnectHandoff';
import { getServerErrorField } from '@client/app/utils/error';
import GitHubSyncedFilesDisclosure from './GitHubSyncedFilesDisclosure';

export const GITHUB_READ_ONLY_PROMISE = 'We can read code, never write, push, or open PRs';
const STORAGE_BLOCKED_MESSAGE =
  'This browser blocked session storage, so we could not start the GitHub connection. Allow it for this site and try again.';
const GENERIC_FAILURE_MESSAGE = 'Could not start the GitHub connection. Please try again.';

/**
 * Create a data lake fed by a GitHub repository. Continue calls the create-and-begin door
 * (useBeginGitHubLakeCreate), saves the handoff so the callback page can find its way back, and
 * leaves for GitHub's authorize page - after which the repository picker finishes the connect.
 *
 * Every failure BEFORE the redirect renders inline with Try again rather than as a toast: the user
 * is standing on this panel with nothing else on screen to act on, and a toast for a blocked
 * handoff disappears while the dead Continue button stays. Once window.location.assign is called
 * the page is leaving, so there is no later failure for this component to report.
 */
export default function GitHubCreatePanel({ organizationId, onBack }: { organizationId: string; onBack: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const begin = useBeginGitHubLakeCreate();

  const handleContinue = () => {
    setError(null);
    begin.mutate(organizationId, {
      onSuccess: ({ dataLakeId, authorizeUrl }) => {
        try {
          saveGitHubLakeConnectHandoff({ dataLakeId });
        } catch {
          // Without the handoff the callback page has nowhere to land once GitHub returns, so the
          // round-trip must not start at all.
          setError(STORAGE_BLOCKED_MESSAGE);
          return;
        }
        window.location.assign(authorizeUrl);
      },
      onError: (e: unknown) => setError(getServerErrorField(e) || GENERIC_FAILURE_MESSAGE),
    });
  };

  return (
    <Stack gap={2} data-testid="github-create-panel" sx={{ maxWidth: 640 }}>
      <Stack direction="row" gap={1.5} alignItems="flex-start">
        <LockOutlinedIcon color="success" />
        <Box>
          <Typography level="title-md" data-testid="github-read-only-promise">
            {GITHUB_READ_ONLY_PROMISE}
          </Typography>
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            You approve the GitHub App, pick one repository, and we keep its text and code files in sync with this lake.
            Disconnecting removes everything it synced.
          </Typography>
        </Box>
      </Stack>

      <GitHubSyncedFilesDisclosure />

      {error && (
        <Alert color="danger" variant="soft" data-testid="github-create-error">
          <Stack gap={1}>
            <Typography level="body-sm">{error}</Typography>
            <Button
              size="sm"
              color="danger"
              variant="soft"
              data-testid="github-create-retry-btn"
              loading={begin.isPending}
              onClick={handleContinue}
              sx={{ alignSelf: 'flex-start' }}
            >
              Try again
            </Button>
          </Stack>
        </Alert>
      )}

      <Stack direction="row" gap={1}>
        <Button
          variant="outlined"
          color="neutral"
          data-testid="github-create-back-btn"
          disabled={begin.isPending}
          onClick={onBack}
        >
          Back
        </Button>
        <Button
          variant="solid"
          color="primary"
          startDecorator={<GitHubIcon />}
          data-testid="github-create-continue-btn"
          loading={begin.isPending}
          onClick={handleContinue}
        >
          Continue with GitHub
        </Button>
      </Stack>
    </Stack>
  );
}
