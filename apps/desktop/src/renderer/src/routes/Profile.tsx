import type { ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Card from '@mui/joy/Card';
import CircularProgress from '@mui/joy/CircularProgress';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { useNavigate } from '@tanstack/react-router';
import { useAuthState } from '../auth/useAuthState';
import { ProfileScreen } from '../profile/ProfileScreen';

function Centered({ children }: { children: ReactNode }) {
  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', bgcolor: 'background.body', p: 3 }}>
      <Card variant="outlined" sx={{ width: 'min(520px, 100%)', gap: 2 }}>
        {children}
      </Card>
    </Box>
  );
}

/**
 * The profile route.
 *
 * Signed out is its own answer rather than an empty chart: nothing can be read about an account
 * nobody is signed in to, and saying "no usage" there would claim a fact about a ledger this
 * app cannot see.
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

  if (state.status !== 'signed-in') {
    return (
      <Centered>
        <Stack spacing={1.5} data-testid="profile-signed-out">
          <Typography level="title-md">Sign in to see your usage</Typography>
          <Typography level="body-sm" textColor="text.tertiary">
            Credit history belongs to an account, so there is nothing to show until this app is signed in to one.
          </Typography>
          <Button size="sm" variant="soft" color="neutral" onClick={back} data-testid="profile-back-btn">
            Back
          </Button>
        </Stack>
      </Centered>
    );
  }

  return <ProfileScreen state={state} onClose={back} />;
}
