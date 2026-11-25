import { useState, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Avatar from '@mui/joy/Avatar';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import Dropdown from '@mui/joy/Dropdown';
import IconButton from '@mui/joy/IconButton';
import ListDivider from '@mui/joy/ListDivider';
import ListItemDecorator from '@mui/joy/ListItemDecorator';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import { useNavigate } from '@tanstack/react-router';
import type { AuthState } from '@shared/auth';
import { updateAttention } from '@shared/update';
import {
  BillingIcon,
  ConversationIcon,
  ExternalLinkIcon,
  GearIcon,
  ModelsIcon,
  SignOutIcon,
  SlidersIcon,
  UserIcon,
} from '../chat/icons';
import { railButtonSx, RailTooltipTitle, type RailAccountContext } from '../chat/rail/PlaceRail';
import type { AppUpdateController } from '../chat/useAppUpdate';
import { RuntimeInfo } from '../components/RuntimeInfo';
import { CreditsMenuHeader } from '../credits/CreditsGlance';
import { CreditsOrb } from '../credits/CreditsOrb';
import { useAccountSelection } from '../credits/useAccountSelection';
import { useCreditsGlance } from '../credits/useCreditsGlance';
import { AccountSwitcher } from './AccountSwitcher';
import { SendFeedbackDialog } from './SendFeedbackDialog';

/** What a click on the update chip does, or undefined in a state with no next step to take. */
export function updateNextStep(update: AppUpdateController): (() => void) | undefined {
  if (update.state.status === 'available') return update.download;
  if (update.state.status === 'ready') return () => void update.install(false);
  return undefined;
}

/** Two letters for the avatar. Falls back to one, then to nothing, rather than to a stray '?'. */
function initials(name: string): string {
  const parts = name.split(/[\s._@-]+/).filter(Boolean);
  if (parts.length === 0) return '';
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2);
  return letters.toUpperCase();
}

const displayNameOf = (state: AuthState) =>
  state.user?.nickname || state.user?.username || state.user?.email || state.user?.id || 'Signed in';

// Says where the click goes, so it is not mistaken for syncing web conversations into this app: that is
// the 'Bike4Mind web' group in the session list (see chat/WebSyncStatus).
const OPEN_WEB_HINT = 'Opens the web app in your browser';

type DotTone = 'warning' | 'neutral';

/**
 * The avatar button at the foot of the rail, and the menu it opens to the right.
 *
 * The dot is the rail's only colour: warning when something is broken (a failing Customize
 * entry, a sign-in error), neutral when an update is merely waiting.
 */
function RailAccountButton({
  face,
  dot,
  onOpenChange,
  children,
}: {
  face: ReactNode;
  dot: DotTone | null;
  /** Reports the menu opening and closing, for reads that should refresh when it opens. */
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Dropdown onOpenChange={(_event, open) => onOpenChange?.(open)}>
      <Tooltip
        title={<RailTooltipTitle label="Account" />}
        placement="right"
        size="sm"
        variant="outlined"
        enterDelay={400}
      >
        <MenuButton
          slots={{ root: IconButton }}
          slotProps={{ root: { variant: 'plain', sx: { ...railButtonSx(false), position: 'relative' } } }}
          aria-label="Account"
          data-testid="place-rail-account-btn"
        >
          {face}
          {dot && (
            <Box
              aria-hidden
              data-testid="place-rail-account-dot"
              data-tone={dot}
              sx={{
                position: 'absolute',
                bottom: 3,
                right: 3,
                width: 8,
                height: 8,
                borderRadius: '50%',
                bgcolor: dot === 'warning' ? 'warning.solidBg' : 'neutral.solidBg',
                border: '1.5px solid',
                borderColor: 'background.level1',
              }}
            />
          )}
        </MenuButton>
      </Tooltip>
      <Menu
        size="sm"
        placement="right-end"
        sx={{ minWidth: 260, maxWidth: 320, '--ListItemDecorator-size': '28px' }}
        data-testid="account-menu"
      >
        {children}
      </Menu>
    </Dropdown>
  );
}

function Row({
  icon,
  label,
  onClick,
  end,
  tooltip,
  testId,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  end?: ReactNode;
  tooltip?: string;
  testId: string;
}) {
  const item = (
    <MenuItem onClick={onClick} data-testid={testId}>
      <ListItemDecorator>{icon}</ListItemDecorator>
      <Box sx={{ flex: 1 }}>{label}</Box>
      {end}
    </MenuItem>
  );
  if (!tooltip) return item;
  return (
    <Tooltip title={tooltip} placement="right" variant="soft" size="sm" data-testid={`${testId}-tooltip`}>
      {item}
    </Tooltip>
  );
}

function ConfigRows({ context }: { context: RailAccountContext }) {
  return (
    <>
      <Row
        icon={<SlidersIcon />}
        label="Customize"
        onClick={context.onOpenCustomize}
        end={
          context.customizeAttention ? (
            <Chip size="sm" variant="soft" color="warning" data-testid="customize-attention-chip">
              {context.customizeAttention}
            </Chip>
          ) : undefined
        }
        testId="account-customize-btn"
      />
      <Row icon={<ModelsIcon />} label="Models" onClick={context.onOpenModels} testId="account-models-btn" />
    </>
  );
}

/**
 * The signed-in account: who, where, any waiting update, and every account and configuration
 * row the sidebar used to carry. The blocked states (no keychain, a failed identity read) head
 * the menu and mark the avatar, because nothing else in the chat UI explains why replies stop.
 */
export function SignedInRailAccount({
  state,
  update,
  context,
}: {
  state: AuthState;
  update: AppUpdateController;
  context: RailAccountContext;
}) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [orbOpen, setOrbOpen] = useState(false);
  // Either surface opening asks for a fresh read; refreshGate decides whether one happens.
  const menuOpen = accountMenuOpen || orbOpen;
  const accountSelection = useAccountSelection(menuOpen, context.spentAt ?? 0);
  const credits = useCreditsGlance(context.spentAt ?? 0, menuOpen, accountSelection.selection?.selected ?? null);
  const navigate = useNavigate();
  const settingsAttention = updateAttention(update.state);
  const user = state.user;
  const displayName = displayNameOf(state);
  const problem = state.storage === 'unavailable' || !!state.error || !!context.customizeAttention;
  const dot: DotTone | null = problem ? 'warning' : settingsAttention ? 'neutral' : null;
  const nextStep = updateNextStep(update);

  return (
    <>
      <CreditsOrb glance={credits} onOpenChange={setOrbOpen} onTopUp={() => void navigate({ to: '/billing' })} />
      <RailAccountButton
        dot={dot}
        onOpenChange={setAccountMenuOpen}
        face={
          // `src` is a b4m-media: URL main wrote to disk; Joy falls back to the initials when it
          // is missing or fails to load, so they are both the placeholder and the final answer.
          <Avatar
            variant="soft"
            color="neutral"
            src={user?.photoUrl}
            alt=""
            sx={{ '--Avatar-size': '26px', fontSize: 11 }}
          >
            {initials(displayName)}
          </Avatar>
        }
      >
        {/* Balance and runway first, so they are one click from anywhere. */}
        <CreditsMenuHeader glance={credits} onTopUp={() => void navigate({ to: '/billing' })} />
        <AccountSwitcher controller={accountSelection} />
        <Stack spacing={0.75} sx={{ px: 1.5, pt: 1, pb: 1 }} data-testid="account-menu-header">
          <Stack direction="row" spacing={1} alignItems="center">
            <Stack sx={{ flex: 1, minWidth: 0 }}>
              <Typography level="title-sm" noWrap data-testid="auth-status-chip">
                {displayName}
              </Typography>
              {/* The strip used to show whatever the account calls itself; the address is what
                  a user recognises on an invoice. */}
              {user?.email && user.email !== displayName && (
                <Typography level="body-xs" textColor="text.tertiary" noWrap data-testid="account-menu-email">
                  {user.email}
                </Typography>
              )}
              {/* Which deployment a reply came from: the desktop identity has no org field. */}
              <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                <Typography level="body-xs" textColor="text.tertiary" noWrap>
                  {state.environment.label}
                </Typography>
                {context.status}
              </Stack>
            </Stack>
            {/* Primary, not danger: an update waiting is not a fault. A click takes the next step. */}
            {settingsAttention && (
              <Chip size="sm" variant="soft" color="primary" onClick={nextStep} data-testid="account-attention-chip">
                {settingsAttention}
              </Chip>
            )}
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
        </Stack>
        <ListDivider />
        <Row
          icon={<GearIcon />}
          label="Settings"
          onClick={() => void navigate({ to: '/settings' })}
          end={
            settingsAttention ? (
              <Chip size="sm" variant="soft" color="primary" data-testid="account-settings-attention-chip">
                {settingsAttention}
              </Chip>
            ) : undefined
          }
          testId="account-settings-btn"
        />
        <ConfigRows context={context} />
        {state.status === 'signed-in' && user && (
          <Row
            icon={<BillingIcon />}
            label="Billing"
            onClick={() => void navigate({ to: '/billing' })}
            testId="account-billing-btn"
          />
        )}
        <Row
          icon={<UserIcon />}
          label="Profile"
          onClick={() => void navigate({ to: '/profile' })}
          testId="account-profile-btn"
        />
        <ListDivider />
        <Row
          icon={<ConversationIcon />}
          label="Send Feedback"
          onClick={() => setFeedbackOpen(true)}
          testId="account-feedback-btn"
        />
        <Row
          icon={<ExternalLinkIcon />}
          label="Open Bike4Mind web"
          tooltip={OPEN_WEB_HINT}
          onClick={() => void window.b4m.attention.openServerSessions()}
          testId="account-open-web-btn"
        />
        <ListDivider />
        <Row
          icon={<SignOutIcon />}
          label={state.busy === 'signing-out' ? 'Signing out...' : 'Sign out'}
          onClick={() => void window.b4m.auth.signOut()}
          testId="auth-signout-btn"
        />
        <ListDivider />
        <Box sx={{ px: 1.5, py: 0.75 }}>
          <RuntimeInfo />
        </Box>
      </RailAccountButton>
      {feedbackOpen && <SendFeedbackDialog onClose={() => setFeedbackOpen(false)} />}
    </>
  );
}

/**
 * The account slot while chatting with local models and no account. Customize and Models stay:
 * local models are configured there, and the sidebar no longer carries those rows.
 */
export function LocalRailAccount({ context, onSignIn }: { context: RailAccountContext; onSignIn: () => void }) {
  const navigate = useNavigate();
  return (
    <RailAccountButton
      dot={context.customizeAttention ? 'warning' : null}
      face={
        <Avatar variant="outlined" color="neutral" sx={{ '--Avatar-size': '26px' }}>
          <UserIcon />
        </Avatar>
      }
    >
      <Row
        icon={<GearIcon />}
        label="Settings"
        onClick={() => void navigate({ to: '/settings' })}
        testId="local-chat-settings-btn"
      />
      <ConfigRows context={context} />
      <ListDivider />
      <Row icon={<UserIcon />} label="Sign in" onClick={onSignIn} testId="local-chat-signin-btn" />
    </RailAccountButton>
  );
}
