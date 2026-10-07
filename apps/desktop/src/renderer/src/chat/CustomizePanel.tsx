import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Switch from '@mui/joy/Switch';
import ToggleButtonGroup from '@mui/joy/ToggleButtonGroup';
import Typography from '@mui/joy/Typography';
import { useColorScheme, useTheme } from '@mui/joy/styles';
import { entryAttentionChip, EntrySection, type ConfigEntry } from './ConfigEntry';
import { CloseIcon, ContrastIcon, ServerIcon, SlidersIcon, SparkIcon } from './icons';
import { McpServersSettings } from './McpServersSettings';
import { NavItem } from './SessionList';
import { columnStackSx, contentColumnSx, scrollingColumnHostSx } from './layout';
import { promptSuggestionsSummary, usePromptSuggestions } from './promptSuggestions';
import { THEME_MODES, currentThemeMode, themeModeSummary, type ResolvedThemeMode, type ThemeMode } from './themeMode';
import { useMcpServers, type McpServersController } from './useMcpServers';

/** What this screen is for, said on the screen so it does not have to be inferred from a name. */
const CUSTOMIZE_INTRO = 'How the app looks, and what it can reach.';

function mcpEntry(controller: McpServersController): ConfigEntry {
  const connected = controller.servers.filter(server => server.status === 'connected').length;
  const failed = controller.servers.filter(server => server.status === 'failed').length;
  const tools = controller.servers.reduce((total, server) => total + server.tools.length, 0);

  // A count rather than a list, because the count is what is wrong when something is wrong: a
  // failed server is otherwise indistinguishable from one that simply declared no tools.
  const summary = (() => {
    if (controller.loading) return 'Loading...';
    if (controller.servers.length === 0) return 'None configured';
    if (connected === 0 && failed === 0) return `${controller.servers.length} configured`;
    return `${connected} connected, ${tools} ${tools === 1 ? 'tool' : 'tools'}`;
  })();

  return {
    id: 'mcp',
    icon: <ServerIcon />,
    label: 'MCP servers',
    summary,
    ...(failed > 0 ? { attention: `${failed} failed` } : {}),
    control: <McpServersSettings controller={controller} />,
  };
}

const THEME_MODE_LABEL: Record<ThemeMode, string> = { system: 'System', light: 'Light', dark: 'Dark' };

/**
 * Light, dark or follow the OS, as three buttons with the current one pressed.
 *
 * It used to cycle in place, because a sidebar row had space for one click and not for a
 * choice. A screen has the space, so the three states are all on show and reaching any of them
 * costs one click rather than up to two - and, more to the point, the control now says what it
 * will do before it is touched instead of only afterwards.
 *
 * `useColorScheme` is used for `setMode` only. The scheme being PAINTED comes from the theme,
 * because `useColorScheme().mode` can be the string 'system', which is not a scheme.
 */
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
        // Joy reports null when the pressed button is clicked again; the app is always in one of
        // the three, so that is a no-op rather than a fourth state.
        onChange={(_event, next) => {
          if (next) setMode(next as ThemeMode);
        }}
        data-testid="customize-appearance-group"
      >
        {THEME_MODES.map(themeMode => (
          <Button key={themeMode} value={themeMode} data-testid={`customize-appearance-${themeMode}-btn`}>
            {THEME_MODE_LABEL[themeMode]}
          </Button>
        ))}
      </ToggleButtonGroup>
    ),
  };
}

/**
 * Whether the composer offers a guess at the next message.
 *
 * What it needs is a place to be turned OFF: it is on by default and it spends a model call per
 * reply, so a user who does not want either has to be able to find the switch. There is
 * deliberately no third state - nothing here makes a suggestion send itself.
 */
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
          input: { 'aria-label': 'Suggested next prompt', 'data-testid': 'customize-suggestions-switch' },
        }}
      />
    ),
  };
}

/**
 * Every appearance-and-tools setting, built once and read by both the nav row and the screen.
 *
 * The row needs only `attention` out of this, but it has to come from the same list the screen
 * draws or the badge would be answering a different question from the section it points at.
 * MCP is now the only entry here that can raise one; the chip still honours `attentionColor`,
 * since what the row has to say about an entry is the entry's to decide.
 */
function useCustomizeEntries(): ConfigEntry[] {
  const mcp = useMcpServers();
  const { mode, setMode } = useColorScheme();
  const theme = useTheme();
  const [suggestions, toggleSuggestions] = usePromptSuggestions();

  return [
    appearanceEntry(mode, setMode, theme.palette.mode),
    suggestionsEntry(suggestions, toggleSuggestions),
    mcpEntry(mcp),
  ];
}

/**
 * The Customize row in the nav, which opens the screen.
 *
 * It carries the attention badge whether or not the screen is showing. On the old collapse the
 * badge was hidden while open, because the entry it named was then one row below it and the
 * chip was saying the same thing twice; a screen replaces the conversation instead, so nothing
 * about which screen is up changes whether the sidebar should report a dead server.
 *
 * That badge is the whole reason MCP lives here: it used to hold a permanent card in the
 * sidebar for a control that is opened rarely, and the failure count was the only part of that
 * card worth the space.
 */
export function CustomizeNavItem({ onOpen }: { onOpen: () => void }) {
  const entries = useCustomizeEntries();

  return (
    <NavItem
      icon={<SlidersIcon />}
      label="Customize"
      onClick={onOpen}
      end={entryAttentionChip(entries, 'customize-attention-chip')}
      testId="chat-customize-btn"
    />
  );
}

/**
 * "Customize": how the app looks and what it can reach, as a screen beside Artifacts.
 *
 * Each setting is on the page rather than behind a row that opens something else. A list of
 * three links that each lead somewhere would be a navigation step bought with a whole screen -
 * strictly worse than the one-row collapse it replaces - so the screen shows the controls
 * themselves and MCP, the one that used to need a window, is a section like the rest.
 *
 * The server and the app's own updates are NOT here; they are Settings. The two screens say
 * which half they own under their titles, so neither has to be searched for the other's half.
 */
export function CustomizeScreen({ onClose }: { onClose: () => void }) {
  const entries = useCustomizeEntries();

  return (
    <Stack sx={{ flex: 1, minWidth: 0, ...columnStackSx }} data-testid="customize-panel">
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ ...contentColumnSx, py: 1.25 }}>
          <Stack sx={{ flex: 1, minWidth: 0 }}>
            <Typography level="title-sm">Customize</Typography>
            <Typography level="body-xs" textColor="text.tertiary">
              {CUSTOMIZE_INTRO}
            </Typography>
          </Stack>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Close customize"
            onClick={onClose}
            data-testid="customize-close-btn"
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
