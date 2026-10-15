import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Switch from '@mui/joy/Switch';
import ToggleButtonGroup from '@mui/joy/ToggleButtonGroup';
import Typography from '@mui/joy/Typography';
import { useColorScheme, useTheme } from '@mui/joy/styles';
import type { AuthState } from '@shared/auth';
import { updateAttention, updateSummary } from '@shared/update';
import { EnvironmentPicker } from '../auth/EnvironmentPicker';
import { EntrySection, type ConfigEntry } from './ConfigEntry';
import { CloseIcon, ContrastIcon, DownloadIcon, ServerIcon, SparkIcon } from './icons';
import { columnStackSx, contentColumnSx, scrollingColumnHostSx } from './layout';
import { promptSuggestionsSummary, usePromptSuggestions } from './promptSuggestions';
import { THEME_MODES, currentThemeMode, themeModeSummary, type ResolvedThemeMode, type ThemeMode } from './themeMode';
import { UpdateSettings } from './UpdateSettings';
import { useAppUpdate, type AppUpdateController } from './useAppUpdate';

/** What this screen is for, said on the screen so it does not have to be inferred from a name. */
const SETTINGS_INTRO = 'How the app looks, behaves, connects, and keeps itself up to date.';

const THEME_MODE_LABEL: Record<ThemeMode, string> = { system: 'System', light: 'Light', dark: 'Dark' };

function appearanceEntry(
  mode: string | undefined,
  setMode: (mode: ThemeMode) => void,
  resolved: ResolvedThemeMode
): ConfigEntry {
  return {
    id: 'appearance',
    icon: <ContrastIcon />,
    label: 'Appearance',
    summary: themeModeSummary(mode, resolved),
    control: (
      <ToggleButtonGroup
        size="sm"
        value={currentThemeMode(mode)}
        onChange={(_event, next) => {
          if (next) setMode(next as ThemeMode);
        }}
        data-testid="settings-appearance-group"
      >
        {THEME_MODES.map(themeMode => (
          <Button key={themeMode} value={themeMode} data-testid={`settings-appearance-${themeMode}-btn`}>
            {THEME_MODE_LABEL[themeMode]}
          </Button>
        ))}
      </ToggleButtonGroup>
    ),
  };
}

function suggestionsEntry(enabled: boolean, toggle: () => void): ConfigEntry {
  return {
    id: 'prompt-suggestions',
    icon: <SparkIcon />,
    label: 'Suggested next prompt',
    summary: promptSuggestionsSummary(enabled),
    control: (
      <Switch
        size="sm"
        checked={enabled}
        onChange={toggle}
        slotProps={{
          input: { 'aria-label': 'Suggested next prompt', 'data-testid': 'settings-suggestions-switch' },
        }}
      />
    ),
  };
}

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
 * Both Settings entries, built when the screen is open and not before.
 *
 * What the app talks to comes before how it maintains itself: the server is the setting a user
 * arrives here to change, and an update is the one that arrives on its own.
 *
 * Nothing stays mounted while the screen is shut. What an unopened Settings still has to report
 * is one string, which the account strip reads for itself - see `useSettingsAttention`.
 */
function useSettingsEntries(auth: AuthState | null): ConfigEntry[] {
  const update = useAppUpdate();
  const { mode, setMode } = useColorScheme();
  const theme = useTheme();
  const [suggestions, toggleSuggestions] = usePromptSuggestions();

  const preferences = [
    appearanceEntry(mode, setMode, theme.palette.mode),
    suggestionsEntry(suggestions, toggleSuggestions),
  ];
  return auth ? [...preferences, serverEntry(auth), updatesEntry(update)] : [...preferences, updatesEntry(update)];
}

/**
 * "Settings": app preferences, connections and maintenance, as a screen beside Customize.
 *
 * Customize owns tool connections. Settings owns app-wide preferences, the deployment a reply
 * comes from, and updates. Each screen says which half it owns under its title.
 *
 * Customize is a nav row and this is not. Two config rows stacked in the nav list read as one
 * thing split in half; Settings is reached from the account menu, where the server it owns used
 * to live, and the strip above that menu carries whatever it needs to say meanwhile.
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
