import { useState } from 'react';
import Alert from '@mui/joy/Alert';
import Avatar from '@mui/joy/Avatar';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { AuthState } from '@shared/auth';
import { ChevronIcon } from '../chat/icons';
import { RuntimeInfo } from '../components/RuntimeInfo';

/** Two letters for the avatar. Falls back to one, then to nothing, rather than to a stray '?'. */
function initials(name: string): string {
  const parts = name.split(/[\s._@-]+/).filter(Boolean);
  if (parts.length === 0) return '';
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2);
  return letters.toUpperCase();
}

/**
 * The account strip at the foot of the sidebar: who is signed in, where, and the way out.
 *
 * Laid out like Claude Code desktop's - avatar, name over organization, and a chevron for the
 * account menu. "Organization" is the b4m ENVIRONMENT here, which is the nearest true thing:
 * the desktop identity has no org field, and where the account lives (hosted, or a self-hosted
 * stack) is what a user actually needs to see to know which deployment a reply came from.
 *
 * The blocked states still surface here, because nothing else in the chat UI would explain why
 * replies suddenly stop working.
 */
export function SignedInPanel({ state }: { state: AuthState }) {
  const [open, setOpen] = useState(false);
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

      <Stack direction="row" spacing={1} alignItems="center">
        <Avatar size="sm" variant="soft" color="primary">
          {initials(displayName)}
        </Avatar>
        <Stack sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="body-sm" noWrap data-testid="auth-status-chip">
            {displayName}
          </Typography>
          <Typography level="body-xs" textColor="text.tertiary" noWrap>
            {state.environment.label}
          </Typography>
        </Stack>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label={open ? 'Hide account options' : 'Show account options'}
          onClick={() => setOpen(current => !current)}
          data-testid="account-menu-btn"
        >
          <ChevronIcon open={open} />
        </IconButton>
      </Stack>

      {open && (
        <Stack spacing={1} data-testid="account-menu">
          <Button
            size="sm"
            variant="soft"
            color="neutral"
            loading={state.busy === 'signing-out'}
            onClick={() => void window.b4m.auth.signOut()}
            data-testid="auth-signout-btn"
          >
            Sign out
          </Button>
          <RuntimeInfo />
        </Stack>
      )}
    </Stack>
  );
}
