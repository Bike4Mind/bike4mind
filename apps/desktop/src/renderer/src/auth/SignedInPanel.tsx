import { useState, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Avatar from '@mui/joy/Avatar';
import Button from '@mui/joy/Button';
import Divider from '@mui/joy/Divider';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { useNavigate } from '@tanstack/react-router';
import type { AuthState } from '@shared/auth';
import { ChevronIcon } from '../chat/icons';
import { RuntimeInfo } from '../components/RuntimeInfo';
import { EnvironmentPicker } from './EnvironmentPicker';

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
export function SignedInPanel({ state, status }: { state: AuthState; status?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
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
        {/* `src` is a b4m-media: URL main wrote to disk, absent until (or unless) it arrives.
            Joy falls back to the children when it is missing or fails to load, so the initials
            below are both the placeholder and the permanent answer for an account with no
            picture - there is no second state to track here. */}
        <Avatar size="sm" variant="soft" color="primary" src={user?.photoUrl} alt="">
          {initials(displayName)}
        </Avatar>
        <Stack sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="body-sm" noWrap data-testid="auth-status-chip">
            {displayName}
          </Typography>
          {/* The turn dot rides at the end of the environment line rather than ahead of it, so
              the name above and the label below keep the same left edge. */}
          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
            <Typography level="body-xs" textColor="text.tertiary" noWrap>
              {state.environment.label}
            </Typography>
            {status}
          </Stack>
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
          {/* First in the menu because it is the only entry that goes anywhere: the balance in
              the composer says what is left, and this is where it says where it went. */}
          <Button
            size="sm"
            variant="soft"
            color="neutral"
            onClick={() => void navigate({ to: '/profile' })}
            data-testid="account-profile-btn"
          >
            Profile
          </Button>

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

          <Divider />

          {/* The server lives here rather than in the composer's chip row because it is
              app-wide, not session-scoped - which is also why the scope is said out loud:
              the one thing the picker's own caption cannot tell you is how far it reaches.
              It is a choice of backend, never of where the agent runs; this app's agent is
              the Electron main process and has nowhere else to go. */}
          <Typography level="body-xs" textColor="text.tertiary">
            Every conversation in this app talks to one server.
          </Typography>
          <EnvironmentPicker state={state} />

          <Divider />

          <RuntimeInfo />
        </Stack>
      )}
    </Stack>
  );
}
