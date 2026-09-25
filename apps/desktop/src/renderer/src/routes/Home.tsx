import Box from '@mui/joy/Box';
import Card from '@mui/joy/Card';
import CircularProgress from '@mui/joy/CircularProgress';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { SignInCard } from '../auth/SignInCard';
import { SignedInPanel } from '../auth/SignedInPanel';
import { useAuthState } from '../auth/useAuthState';

export function Home() {
  const state = useAuthState();

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
        ) : state.status === 'signed-in' ? (
          <SignedInPanel state={state} />
        ) : (
          <SignInCard state={state} />
        )}
      </Card>
    </Box>
  );
}
