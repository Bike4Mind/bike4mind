import Box from '@mui/joy/Box';
import Card from '@mui/joy/Card';
import CircularProgress from '@mui/joy/CircularProgress';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { ReauthNotice } from '../auth/ReauthNotice';
import { SignInCard } from '../auth/SignInCard';
import { SignedInPanel } from '../auth/SignedInPanel';
import { useAuthState } from '../auth/useAuthState';
import { ChatShell } from '../chat/ChatShell';

export function Home() {
  const state = useAuthState();

  // Signed in, the window belongs to the conversation; identity moves to the sidebar footer. A
  // session that expired under the user keeps it too, mounted in the same place so nothing in it
  // (the composer's draft above all) is torn down while they sign in again.
  if (state?.status === 'signed-in' || state?.reauthRequired) {
    return (
      <>
        <ChatShell
          auth={state}
          account={(status, openSettings) => (
            <SignedInPanel state={state} status={status} onOpenSettings={openSettings} />
          )}
        />
        {state.reauthRequired && <ReauthNotice state={state} />}
      </>
    );
  }

  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', bgcolor: 'background.body', p: 3 }}>
      <Card variant="outlined" sx={{ width: 'min(520px, 100%)', gap: 2 }}>
        {!state || state.status === 'initializing' ? (
          <Stack direction="row" spacing={1.5} alignItems="center" data-testid="auth-loading-stack">
            <CircularProgress size="sm" />
            <Typography level="body-sm" textColor="text.tertiary">
              Checking your saved sign-in...
            </Typography>
          </Stack>
        ) : (
          <SignInCard state={state} />
        )}
      </Card>
    </Box>
  );
}
