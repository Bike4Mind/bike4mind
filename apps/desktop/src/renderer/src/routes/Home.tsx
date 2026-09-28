import Box from '@mui/joy/Box';
import Card from '@mui/joy/Card';
import CircularProgress from '@mui/joy/CircularProgress';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { SignInCard } from '../auth/SignInCard';
import { SignedInPanel } from '../auth/SignedInPanel';
import { useAuthState } from '../auth/useAuthState';
import { ChatShell } from '../chat/ChatShell';

export function Home() {
  const state = useAuthState();

  // Signed in, the window belongs to the conversation; identity moves to the sidebar footer.
  if (state?.status === 'signed-in') {
    return <ChatShell account={<SignedInPanel state={state} />} />;
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
