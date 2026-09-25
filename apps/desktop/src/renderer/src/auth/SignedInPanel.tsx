import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import Divider from '@mui/joy/Divider';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { AuthState } from '@shared/auth';
import { RuntimeInfo } from '../components/RuntimeInfo';

/**
 * The signed-in shell. Deliberately thin: it exists to prove the identity round-trip, and
 * chat, sessions and model selection arrive in later tasks.
 */
export function SignedInPanel({ state }: { state: AuthState }) {
  const user = state.user;
  const displayName = user?.nickname || user?.username || user?.email || user?.id || 'Signed in';

  return (
    <Stack spacing={2}>
      <Stack spacing={0.5}>
        <Typography level="h2">{displayName}</Typography>
        {user?.email && user.email !== displayName && (
          <Typography level="body-sm" textColor="text.secondary">
            {user.email}
          </Typography>
        )}
      </Stack>

      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Chip size="sm" variant="soft" color="success" data-testid="auth-status-chip">
          Signed in
        </Chip>
        <Typography level="body-xs" fontFamily="monospace" textColor="text.tertiary">
          {state.environment.label} - {state.environment.url}
        </Typography>
      </Stack>

      {state.storage === 'unavailable' && (
        <Alert color="warning" variant="soft" size="sm" data-testid="auth-storage-alert">
          No OS keychain is available here, so this sign-in lasts only until you quit.
        </Alert>
      )}

      {state.error && (
        <Alert
          color="warning"
          variant="soft"
          size="sm"
          data-testid="auth-error-alert"
          endDecorator={
            <Button
              size="sm"
              variant="soft"
              color="warning"
              loading={state.busy === 'restoring'}
              onClick={() => void window.b4m.auth.retryIdentity()}
              data-testid="auth-retry-identity-btn"
            >
              Retry
            </Button>
          }
        >
          {state.error.message}
        </Alert>
      )}

      <Divider />
      <RuntimeInfo />
      <Divider />

      <Stack direction="row">
        <Button
          variant="soft"
          color="neutral"
          loading={state.busy === 'signing-out'}
          onClick={() => void window.b4m.auth.signOut()}
          data-testid="auth-signout-btn"
        >
          Sign out
        </Button>
      </Stack>
    </Stack>
  );
}
