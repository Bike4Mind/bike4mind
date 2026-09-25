import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import Divider from '@mui/joy/Divider';
import Link from '@mui/joy/Link';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { AuthState } from '@shared/auth';
import { EnvironmentPicker } from './EnvironmentPicker';

/**
 * Everything that is not a signed-in session. The three states that are NOT sign-in failures
 * each get their own copy and their own next step:
 * - `awaiting-approval`: the code and URI, so a browser that did not open is not a dead end.
 * - `policy-acceptance-required`: a link to accept, then continue without signing in again.
 * - `mfa-required`: finish the second factor on the web app, then sign in again.
 */
export function SignInCard({ state }: { state: AuthState }) {
  const signingIn = state.busy === 'signing-in';

  return (
    <Stack spacing={2}>
      <Stack spacing={0.5}>
        <Typography level="h2">Bike4Mind Desktop</Typography>
        <Typography level="body-md" textColor="text.secondary">
          Sign in with your browser to connect this app to your account.
        </Typography>
      </Stack>

      {state.storage === 'unavailable' && (
        <Alert color="warning" variant="soft" size="sm" data-testid="auth-storage-alert">
          No OS keychain is available here, so your sign-in cannot be saved securely. You will stay signed in until you
          quit, and will need to sign in again next time. Credentials are never written to disk in plain text.
        </Alert>
      )}

      {state.status === 'awaiting-approval' && state.pending ? (
        <ApprovalPanel state={state} />
      ) : (
        <>
          {state.error && (
            <Alert
              color={state.status === 'signed-out' || state.status === 'unconfigured' ? 'danger' : 'warning'}
              variant="soft"
              size="sm"
              data-testid="auth-error-alert"
            >
              {state.error.message}
            </Alert>
          )}

          <BlockedActions state={state} />

          {state.status !== 'unconfigured' && (
            <Button
              loading={signingIn || state.busy === 'restoring'}
              disabled={state.status === 'policy-acceptance-required' || state.status === 'mfa-required'}
              onClick={() => void window.b4m.auth.signIn()}
              data-testid="auth-signin-btn"
            >
              Sign in
            </Button>
          )}

          <Divider />
          <EnvironmentPicker state={state} disabled={signingIn} />
        </>
      )}
    </Stack>
  );
}

function BlockedActions({ state }: { state: AuthState }) {
  if (state.status === 'policy-acceptance-required') {
    return (
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button
          variant="solid"
          onClick={() => void window.b4m.auth.openAccountPage('policy')}
          data-testid="auth-accept-policy-btn"
        >
          Review and accept
        </Button>
        <Button
          variant="soft"
          loading={state.busy === 'restoring'}
          onClick={() => void window.b4m.auth.retryIdentity()}
          data-testid="auth-retry-identity-btn"
        >
          I have accepted, continue
        </Button>
        <Button variant="plain" color="neutral" onClick={() => void window.b4m.auth.signOut()}>
          Sign out
        </Button>
      </Stack>
    );
  }

  if (state.status === 'mfa-required') {
    return (
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button
          variant="solid"
          onClick={() => void window.b4m.auth.openAccountPage('mfa')}
          data-testid="auth-complete-mfa-btn"
        >
          Finish two-factor setup
        </Button>
        <Button
          variant="soft"
          loading={state.busy === 'restoring'}
          onClick={() => void window.b4m.auth.retryIdentity()}
          data-testid="auth-retry-identity-btn"
        >
          Done, continue
        </Button>
        <Button variant="plain" color="neutral" onClick={() => void window.b4m.auth.signOut()}>
          Sign out
        </Button>
      </Stack>
    );
  }

  return null;
}

function ApprovalPanel({ state }: { state: AuthState }) {
  const pending = state.pending!;

  return (
    <Stack spacing={2}>
      <Alert color={pending.browserOpened ? 'primary' : 'warning'} variant="soft" size="sm">
        {pending.browserOpened
          ? 'Approve this device in the browser window that just opened.'
          : 'The browser could not be opened. Visit the address below and enter the code.'}
      </Alert>

      <Stack spacing={0.5}>
        <Typography level="body-sm" textColor="text.tertiary">
          Your code
        </Typography>
        <Typography level="h1" fontFamily="monospace" letterSpacing="0.2em" data-testid="auth-user-code-text">
          {pending.userCode}
        </Typography>
      </Stack>

      <Stack spacing={0.5}>
        <Typography level="body-sm" textColor="text.tertiary">
          Verification address
        </Typography>
        <Link
          level="body-sm"
          fontFamily="monospace"
          onClick={() => void window.b4m.auth.openAccountPage('verification')}
          data-testid="auth-verification-uri-link"
        >
          {pending.verificationUri}
        </Link>
      </Stack>

      <Stack direction="row" spacing={1}>
        <Button
          variant="soft"
          onClick={() => void window.b4m.auth.openAccountPage('verification')}
          data-testid="auth-reopen-browser-btn"
        >
          Open browser again
        </Button>
        <Button
          variant="plain"
          color="neutral"
          onClick={() => void window.b4m.auth.cancelSignIn()}
          data-testid="auth-cancel-signin-btn"
        >
          Cancel
        </Button>
      </Stack>
    </Stack>
  );
}
