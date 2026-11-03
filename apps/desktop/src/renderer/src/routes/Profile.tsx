import { useState, type ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Card from '@mui/joy/Card';
import CircularProgress from '@mui/joy/CircularProgress';
import IconButton from '@mui/joy/IconButton';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { useNavigate } from '@tanstack/react-router';
import type { UsageWindowId } from '@shared/usage';
import { useAuthState } from '../auth/useAuthState';
import { ArrowLeftIcon, ReloadIcon } from '../chat/icons';
import { columnStackSx, contentColumnSx, scrollingColumnHostSx } from '../chat/layout';
import { LocalUsageCard } from '../profile/LocalUsageCard';
import { ProfileScreen } from '../profile/ProfileScreen';
import { UsageWindowToggle } from '../profile/UsageWindowToggle';
import { useLocalUsage } from '../profile/useLocalUsage';
import { WINDOW_LABELS } from '../profile/usageView';

function Centered({ children }: { children: ReactNode }) {
  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', bgcolor: 'background.body', p: 3 }}>
      <Card variant="outlined" sx={{ width: 'min(520px, 100%)', gap: 2 }}>
        {children}
      </Card>
    </Box>
  );
}

function SignInPrompt({ onBack }: { onBack?: () => void }) {
  return (
    <Stack spacing={1.5} data-testid="profile-signed-out">
      <Typography level="title-md">Sign in to see your usage</Typography>
      <Typography level="body-sm" textColor="text.tertiary">
        Credit history belongs to an account, so there is nothing to show until this app is signed in to one.
      </Typography>
      {onBack && (
        <Button size="sm" variant="soft" color="neutral" onClick={onBack} data-testid="profile-back-btn">
          Back
        </Button>
      )}
    </Stack>
  );
}

/**
 * Signed out: the sign-in prompt, and below it the self-hosted model usage this device's own
 * conversations hold. Only the prompt, as before, until there is a local reply to show.
 */
export function SignedOutProfile({ onBack }: { onBack: () => void }) {
  const [windowId, setWindowId] = useState<UsageWindowId>('last-24-hours');
  const [reload, setReload] = useState(0);
  const [hasLocal, setHasLocal] = useState(false);
  const local = useLocalUsage(windowId, reload);
  // Sticky, so switching windows does not drop the screen back to the bare prompt mid-read.
  if (!hasLocal && local?.ok && local.usage.allTimeReplies > 0) setHasLocal(true);

  if (!hasLocal) {
    return (
      <Centered>
        <SignInPrompt onBack={onBack} />
      </Centered>
    );
  }

  const usage = local?.ok ? local.usage : null;
  return (
    <Stack sx={{ height: '100vh', bgcolor: 'background.body', ...columnStackSx }} data-testid="profile-screen">
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ ...contentColumnSx, py: 1.25 }}>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Back to conversations"
            onClick={onBack}
            data-testid="profile-close-btn"
          >
            <ArrowLeftIcon />
          </IconButton>
          <Typography level="title-sm" sx={{ flex: 1 }}>
            Profile
          </Typography>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Refresh usage"
            onClick={() => setReload(current => current + 1)}
            data-testid="profile-refresh-btn"
          >
            <ReloadIcon />
          </IconButton>
        </Stack>
      </Box>

      <Box sx={{ flex: 1, ...scrollingColumnHostSx }}>
        <Box sx={{ ...contentColumnSx, py: 2 }}>
          <Sheet variant="outlined" sx={{ borderRadius: 'sm', px: 2, py: 1.75, mb: 1.5 }}>
            <SignInPrompt />
          </Sheet>
          <UsageWindowToggle value={windowId} onChange={setWindowId} />
          {usage && usage.totals.replies === 0 && (
            <Typography level="body-sm" textColor="text.tertiary" data-testid="profile-local-empty">
              No self-hosted model replies in the {WINDOW_LABELS[windowId].toLowerCase()}.
            </Typography>
          )}
          {usage && <LocalUsageCard usage={usage} />}
        </Box>
      </Box>
    </Stack>
  );
}

/**
 * The profile route.
 *
 * Signed out is its own answer rather than an empty chart: nothing can be read about an account
 * nobody is signed in to, and saying "no usage" there would claim a fact about a ledger this
 * app cannot see. Self-hosted usage is this device's own, so it is shown either way.
 */
export function Profile() {
  const state = useAuthState();
  const navigate = useNavigate();
  const back = () => void navigate({ to: '/' });

  if (!state || state.status === 'initializing') {
    return (
      <Centered>
        <Stack direction="row" spacing={1.5} alignItems="center" data-testid="profile-auth-loading">
          <CircularProgress size="sm" />
          <Typography level="body-sm" textColor="text.tertiary">
            Checking your saved sign-in...
          </Typography>
        </Stack>
      </Centered>
    );
  }

  if (state.status !== 'signed-in') return <SignedOutProfile onBack={back} />;

  return <ProfileScreen state={state} onClose={back} />;
}
