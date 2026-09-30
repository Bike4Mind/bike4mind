import type { ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import IconButton from '@mui/joy/IconButton';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Switch from '@mui/joy/Switch';
import ToggleButtonGroup from '@mui/joy/ToggleButtonGroup';
import Typography from '@mui/joy/Typography';
import { useColorScheme, useTheme } from '@mui/joy/styles';
import { updateAttention, updateSummary } from '@shared/update';
import { CloseIcon, ContrastIcon, DownloadIcon, GearIcon, ServerIcon, SparkIcon } from './icons';
import { McpServersSettings } from './McpServersSettings';
import { NavItem } from './SessionList';
import { columnStackSx, contentColumnSx, scrollingColumnHostSx } from './layout';
import { promptSuggestionsSummary, usePromptSuggestions } from './promptSuggestions';
import { THEME_MODES, currentThemeMode, themeModeSummary, type ResolvedThemeMode, type ThemeMode } from './themeMode';
import { UpdateSettings } from './UpdateSettings';
import { useAppUpdate, type AppUpdateController } from './useAppUpdate';
import { useMcpServers, type McpServersController } from './useMcpServers';

/**
 * One thing the user can configure about the app itself.
 *
 * Deliberately not shaped around MCP: `summary` is whatever one line describes the current
 * state, and `attention` is whatever is wrong with it. A second entry - folder access is the
 * one this is waiting for - fills the same fields and needs no change here.
 *
 * `control` is the setting itself, rendered on the screen under the label. An entry that has
 * none falls back to `onOpen` behind a button, which is what an entry whose control is a
 * window of its own - an OS permission prompt, say - still wants.
 */
export interface CustomizeEntry {
  id: string;
  icon: ReactNode;
  label: string;
  /** Current state in one line, so the section answers the easy question before it is read. */
  summary: string;
  /** Set only when the entry needs the user; also surfaced on the Customize nav row. */
  attention?: string;
  /**
   * How to colour that chip. Danger by default, because every entry that had one until now was
   * reporting something broken. An update is not broken - drawing "Restart" in the same red as
   * a dead MCP server would read as a fault the user has to go and fix.
   */
  attentionColor?: 'danger' | 'primary';
  control?: ReactNode;
  onOpen?: () => void;
}

function mcpEntry(controller: McpServersController): CustomizeEntry {
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
): CustomizeEntry {
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
function suggestionsEntry(enabled: boolean, toggle: () => void): CustomizeEntry {
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
 * The app's own version, and the only place an update is offered.
 *
 * It sits last so a broken MCP server still wins the one chip the nav row has room for: a
 * server that is down is stopping work now, and an update can wait for the screen to be opened.
 */
function updateEntry(controller: AppUpdateController): CustomizeEntry {
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
 * Every app-level setting, built once and read by both the nav row and the screen.
 *
 * The row needs only `attention` out of this, but it has to come from the same list the screen
 * draws or the badge would be answering a different question from the section it points at.
 */
function useCustomizeEntries(): CustomizeEntry[] {
  const mcp = useMcpServers();
  const update = useAppUpdate();
  const { mode, setMode } = useColorScheme();
  const theme = useTheme();
  const [suggestions, toggleSuggestions] = usePromptSuggestions();

  return [
    appearanceEntry(mode, setMode, theme.palette.mode),
    suggestionsEntry(suggestions, toggleSuggestions),
    mcpEntry(mcp),
    updateEntry(update),
  ];
}

function EntrySection({ entry }: { entry: CustomizeEntry }) {
  return (
    <Sheet
      variant="outlined"
      sx={{ borderRadius: 'sm', mb: 1, px: 1.5, py: 1.25 }}
      data-testid="customize-section"
      data-entry={entry.id}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Box sx={{ color: 'text.tertiary', display: 'flex' }}>{entry.icon}</Box>
        <Stack sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="title-sm" noWrap>
            {entry.label}
          </Typography>
          <Typography level="body-xs" textColor="text.tertiary" noWrap data-testid="customize-entry-summary">
            {entry.summary}
          </Typography>
        </Stack>
        {entry.attention && (
          <Chip
            size="sm"
            variant="soft"
            color={entry.attentionColor ?? 'danger'}
            data-testid="customize-entry-attention"
          >
            {entry.attention}
          </Chip>
        )}
        {/* An entry with no control of its own keeps the button it used to have in the list. */}
        {!entry.control && entry.onOpen && (
          <Button size="sm" variant="soft" color="neutral" onClick={entry.onOpen} data-testid="customize-entry-btn">
            Open
          </Button>
        )}
      </Stack>

      {entry.control && <Box sx={{ mt: 1.25 }}>{entry.control}</Box>}
    </Sheet>
  );
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
  const flagged = useCustomizeEntries().find(entry => entry.attention);

  return (
    <NavItem
      icon={<GearIcon />}
      label="Customize"
      onClick={onOpen}
      end={
        flagged?.attention ? (
          <Chip
            size="sm"
            variant="soft"
            color={flagged.attentionColor ?? 'danger'}
            data-testid="customize-attention-chip"
          >
            {flagged.attention}
          </Chip>
        ) : undefined
      }
      testId="chat-customize-btn"
    />
  );
}

/**
 * "Customize": where the app's own settings live, as a screen beside Artifacts.
 *
 * Each setting is on the page rather than behind a row that opens something else. A list of
 * three links that each lead somewhere would be a navigation step bought with a whole screen -
 * strictly worse than the one-row collapse it replaces - so the screen shows the controls
 * themselves and MCP, the one that used to need a window, is a section like the rest.
 */
export function CustomizeScreen({ onClose }: { onClose: () => void }) {
  const entries = useCustomizeEntries();

  return (
    <Stack sx={{ flex: 1, minWidth: 0, ...columnStackSx }} data-testid="customize-panel">
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ ...contentColumnSx, py: 1.25 }}>
          <Typography level="title-sm" sx={{ flex: 1 }}>
            Customize
          </Typography>
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
