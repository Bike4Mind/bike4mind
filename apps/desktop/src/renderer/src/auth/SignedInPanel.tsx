import { useState, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Avatar from '@mui/joy/Avatar';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import Divider from '@mui/joy/Divider';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { useNavigate } from '@tanstack/react-router';
import type { AuthState } from '@shared/auth';
import { ChevronIcon, GearIcon, SignOutIcon, UserIcon } from '../chat/icons';
import { NavItem } from '../chat/SessionList';
import { useSettingsAttention } from '../chat/settingsAttention';
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
 *
 * The environment LABEL stays even though the picker that sets it moved to Settings: it is a
 * readout, and which deployment a reply came from is worth a line under the name whether or not
 * anyone is about to change it.
 */
export function SignedInPanel({
  state,
  status,
  onOpenSettings,
}: {
  state: AuthState;
  status?: ReactNode;
  onOpenSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const settingsAttention = useSettingsAttention();
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
        {/* Primary, not danger: an update waiting is not a fault. Hidden while the menu is
            open, because the Settings row it points at is then two rows below and the chip
            would be saying the same thing twice. */}
        {settingsAttention && !open && (
          <Chip size="sm" variant="soft" color="primary" data-testid="account-attention-chip">
            {settingsAttention}
          </Chip>
        )}
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
        <AccountMenu
          state={state}
          attention={settingsAttention}
          onOpenSettings={onOpenSettings}
          onProfile={() => void navigate({ to: '/profile' })}
        />
      )}
    </Stack>
  );
}

/**
 * The account menu's own rows, split out so they can be rendered on their own.
 *
 * Worth a component rather than a block inside the strip: this is now the only way into
 * Settings, and a collapsed menu renders nothing - a test of the strip cannot reach the row
 * that matters without opening it.
 */
export function AccountMenu({
  state,
  attention,
  onOpenSettings,
  onProfile,
}: {
  state: AuthState;
  attention?: string;
  onOpenSettings?: () => void;
  onProfile: () => void;
}) {
  const user = state.user;
  const displayName = user?.nickname || user?.username || user?.email || user?.id || 'Signed in';

  return (
    <Stack spacing={0.25} data-testid="account-menu">
      {/* The strip above shows whatever the account calls itself, which for most users is a
          nickname. The address is what they would recognise on an invoice. */}
      {user?.email && user.email !== displayName && (
        <Typography
          level="body-xs"
          textColor="text.tertiary"
          noWrap
          sx={{ px: 1, pb: 0.5 }}
          data-testid="account-menu-email"
        >
          {user.email}
        </Typography>
      )}

      {/* Rows rather than full-width buttons: these are places to go, and a stack of solid
          blocks reads as a stack of commands. Same component the nav above the list uses,
          so the sidebar has one row shape from top to bottom. */}
      <NavItem icon={<UserIcon />} label="Profile" onClick={onProfile} testId="account-profile-btn" />

      {/* The only way into Settings. It is not in the nav list above: a second config row
          under Customize read as the same thing twice, and the server used to live in this
          menu anyway. One row rather than a copy of the picker - two live controls for one
          setting is how they drift apart. */}
      {onOpenSettings && (
        <NavItem
          icon={<GearIcon />}
          label="Settings"
          onClick={onOpenSettings}
          end={
            attention ? (
              <Chip size="sm" variant="soft" color="primary" data-testid="account-settings-attention-chip">
                {attention}
              </Chip>
            ) : undefined
          }
          testId="account-settings-btn"
        />
      )}

      <Divider sx={{ my: 0.5 }} />

      <NavItem
        icon={<SignOutIcon />}
        label="Sign out"
        loading={state.busy === 'signing-out'}
        onClick={() => void window.b4m.auth.signOut()}
        testId="auth-signout-btn"
      />

      <Divider sx={{ my: 0.5 }} />

      <Box sx={{ px: 1, pt: 0.5 }}>
        <RuntimeInfo />
      </Box>
    </Stack>
  );
}
