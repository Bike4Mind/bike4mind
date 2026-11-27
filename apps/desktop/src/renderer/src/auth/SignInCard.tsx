import { useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Divider from '@mui/joy/Divider';
import Link from '@mui/joy/Link';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { AuthState } from '@shared/auth';
import { EnvironmentPicker } from './EnvironmentPicker';
import bike4mindLogo from '../../favicon.png';
import { ArrowRightIcon } from '../chat/icons';

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
    <Stack spacing={3}>
      <Stack spacing={2}>
        <Stack spacing={1.25} alignItems="center">
          <Box
            component="img"
            src={bike4mindLogo}
            alt="Bike4Mind"
            data-testid="auth-brand-logo"
            sx={{ width: 88, height: 88 }}
          />
          <Typography level="title-lg" component="h1">
            Bike4Mind{' '}
            <Typography level="body-sm" textColor="text.tertiary">
              Desktop
            </Typography>
          </Typography>
        </Stack>
      </Stack>
      <Stack spacing={1}>
        <Typography level="body-xs" textColor="text.tertiary">
          Sign in securely in your browser, then return here.
        </Typography>

        {state.storage === 'unavailable' && (
          <Alert color="warning" variant="soft" size="sm" data-testid="auth-storage-alert">
            No OS keychain is available here, so your sign-in cannot be saved securely. You will stay signed in until
            you quit, and will need to sign in again next time. Credentials are never written to disk in plain text.
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
                endDecorator={<ArrowRightIcon />}
                sx={{ minHeight: 44, borderRadius: 'sm' }}
                data-testid="auth-signin-btn"
              >
                Sign in with browser
              </Button>
            )}

            <ServerChoice state={state} disabled={signingIn} />
          </>
        )}
      </Stack>
    </Stack>
  );
}

/**
 * Once a server resolves it is one line, so the default path is a single click on Sign in. The
 * picker sits behind "Change server", and is open from the start when nothing resolves.
 */
function ServerChoice({ state, disabled }: { state: AuthState; disabled: boolean }) {
  const [changing, setChanging] = useState(false);

  if (changing || state.status === 'unconfigured') {
    return (
      <>
        <Divider />
        <EnvironmentPicker state={state} disabled={disabled} onApplied={() => setChanging(false)} />
      </>
    );
  }

  return (
    <Stack spacing={0.75} sx={{ mt: 1.5, p: 1.5, borderRadius: 'sm', bgcolor: 'background.level1' }}>
      <Typography level="body-sm" textColor="text.tertiary" data-testid="signin-server-text">
        Server: {state.environment.label}{' '}
        <Typography
          component="span"
          fontFamily="monospace"
          fontSize="inherit"
          textColor="inherit"
          sx={{ overflowWrap: 'anywhere' }}
        >
          ({state.environment.url})
        </Typography>
      </Typography>
      <Link
        level="body-sm"
        component="button"
        // Joy's `disabled` on a Link blocks the pointer but not a keyboard press.
        disabled={disabled}
        aria-disabled={disabled || undefined}
        onClick={() => !disabled && setChanging(true)}
        data-testid="signin-change-server-link"
        sx={{ alignSelf: 'flex-start', fontSize: 'xs' }}
      >
        Change server
      </Link>
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
        <Button variant="outlined" color="neutral" onClick={() => void window.b4m.auth.signOut()}>
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
        <Button variant="outlined" color="neutral" onClick={() => void window.b4m.auth.signOut()}>
          Sign out
        </Button>
      </Stack>
    );
  }

  return null;
}

export function ApprovalPanel({ state }: { state: AuthState }) {
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
          variant="outlined"
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
