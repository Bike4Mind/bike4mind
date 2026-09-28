import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { AuthState } from '@shared/auth';
import { FolderAccess } from '../chat/FolderAccess';
import { RuntimeInfo } from '../components/RuntimeInfo';

/**
 * The account strip under the session list: who is signed in, where, and the way out.
 *
 * Compact on purpose - now that chat owns the window, identity is context rather than the
 * subject. The blocked states (storage, identity errors) still surface here, because nothing
 * else in the chat UI would explain why replies suddenly stop working.
 */
export function SignedInPanel({ state }: { state: AuthState }) {
  const user = state.user;
  const displayName = user?.nickname || user?.username || user?.email || user?.id || 'Signed in';

  return (
    <Stack spacing={1} sx={{ p: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
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

      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
        <Stack sx={{ minWidth: 0 }}>
          <Typography level="body-sm" noWrap data-testid="auth-status-chip">
            {displayName}
          </Typography>
          <Typography level="body-xs" textColor="text.tertiary" noWrap>
            {state.environment.label}
          </Typography>
        </Stack>
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          loading={state.busy === 'signing-out'}
          onClick={() => void window.b4m.auth.signOut()}
          data-testid="auth-signout-btn"
        >
          Sign out
        </Button>
      </Stack>

      <FolderAccess />

      <Box component="details">
        <Typography component="summary" level="body-xs" textColor="text.tertiary" sx={{ cursor: 'pointer' }}>
          Runtime
        </Typography>
        <Box sx={{ pt: 1 }}>
          <RuntimeInfo />
        </Box>
      </Box>
    </Stack>
  );
}
