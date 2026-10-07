import Box from '@mui/joy/Box';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { AuthState } from '@shared/auth';
import { updateAttention, updateSummary } from '@shared/update';
import { EnvironmentPicker } from '../auth/EnvironmentPicker';
import { entryAttentionChip, EntrySection, type ConfigEntry } from './ConfigEntry';
import { CloseIcon, DownloadIcon, GearIcon, ServerIcon } from './icons';
import { NavItem } from './SessionList';
import { columnStackSx, contentColumnSx, scrollingColumnHostSx } from './layout';
import { UpdateSettings } from './UpdateSettings';
import { useAppUpdate, type AppUpdateController } from './useAppUpdate';

/** What this screen is for, said on the screen so it does not have to be inferred from a name. */
const SETTINGS_INTRO = 'What this app connects to, and how it keeps itself up to date.';

/**
 * Which backend every conversation talks to.
 *
 * It used to live in the account menu, which is where a user looks for who they are rather than
 * for what the app is wired to. The signed-out card keeps its own copy of this picker - someone
 * whose saved server is unreachable has to be able to change it before they can reach any screen.
 */
function serverEntry(state: AuthState): ConfigEntry {
  return {
    id: 'server',
    icon: <ServerIcon />,
    label: 'Server',
    summary: state.environment.url ? state.environment.label : 'No server is set yet',
    control: (
      <Stack spacing={1.5}>
        {/* The scope is said out loud because it is the one thing the picker's own caption
            cannot tell you: how far the choice reaches. It is a choice of backend, never of
            where the agent runs; this app's agent is the Electron main process and has
            nowhere else to go. */}
        <Typography level="body-xs" textColor="text.tertiary">
          Every conversation in this app talks to one server.
        </Typography>
        <EnvironmentPicker state={state} />
      </Stack>
    ),
  };
}

/** The app's own version, and the only place an update is offered. */
function updatesEntry(controller: AppUpdateController): ConfigEntry {
  const attention = updateAttention(controller.state);
  return {
    id: 'updates',
    icon: <DownloadIcon />,
    label: 'Updates',
    summary: updateSummary(controller.state),
    ...(attention ? { attention, attentionColor: 'primary' as const } : {}),
    control: <UpdateSettings controller={controller} />,
  };
}

/**
 * Both Settings entries, built once and read by the nav row as well as the screen.
 *
 * What the app talks to comes before how it maintains itself: the server is the setting a user
 * arrives here to change, and an update is the one that arrives on its own.
 *
 * `useAppUpdate` only subscribes - main pushes, nothing here polls - so the nav row holding this
 * open while the screen is shut costs one listener and no traffic.
 */
function useSettingsEntries(auth: AuthState | null): ConfigEntry[] {
  const update = useAppUpdate();

  return auth ? [serverEntry(auth), updatesEntry(update)] : [updatesEntry(update)];
}

/**
 * The Settings row in the nav, which opens the screen.
 *
 * It carries its own attention badge for the same reason Customize carries one: an update that
 * is ready to install is the only way the user learns about it, and it would go unseen if the
 * badge stayed with the screen the entry used to live on.
 */
export function SettingsNavItem({ auth, onOpen }: { auth: AuthState | null; onOpen: () => void }) {
  const entries = useSettingsEntries(auth);

  return (
    <NavItem
      icon={<GearIcon />}
      label="Settings"
      onClick={onOpen}
      end={entryAttentionChip(entries, 'settings-attention-chip')}
      testId="chat-settings-btn"
    />
  );
}

/**
 * "Settings": what the app connects to and how it is maintained, as a screen beside Customize.
 *
 * The split with Customize is by subject, not by importance: nothing here changes how the app
 * looks or what it can reach, and nothing in Customize changes which deployment a reply came
 * from. Each screen says which half it owns under its title, so neither has to be searched.
 */
export function SettingsScreen({ auth, onClose }: { auth: AuthState | null; onClose: () => void }) {
  const entries = useSettingsEntries(auth);

  return (
    <Stack sx={{ flex: 1, minWidth: 0, ...columnStackSx }} data-testid="settings-panel">
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ ...contentColumnSx, py: 1.25 }}>
          <Stack sx={{ flex: 1, minWidth: 0 }}>
            <Typography level="title-sm">Settings</Typography>
            <Typography level="body-xs" textColor="text.tertiary">
              {SETTINGS_INTRO}
            </Typography>
          </Stack>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Close settings"
            onClick={onClose}
            data-testid="settings-close-btn"
          >
            <CloseIcon />
          </IconButton>
        </Stack>
      </Box>

      <Box sx={{ flex: 1, ...scrollingColumnHostSx }}>
        <Box sx={{ ...contentColumnSx, py: 2 }}>
          {entries.map(entry => (
            <EntrySection key={entry.id} entry={entry} />
          ))}
        </Box>
      </Box>
    </Stack>
  );
}
