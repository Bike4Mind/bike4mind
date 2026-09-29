import { useState, type ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { useColorScheme, useTheme } from '@mui/joy/styles';
import { ChevronIcon, ContrastIcon, GearIcon, ServerIcon, SparkIcon } from './icons';
import { McpServersDialog } from './McpServersDialog';
import { NavItem } from './SessionList';
import { promptSuggestionsSummary, usePromptSuggestions } from './promptSuggestions';
import { nextThemeMode, themeModeSummary, type ResolvedThemeMode, type ThemeMode } from './themeMode';
import { useMcpServers, type McpServersController } from './useMcpServers';

/**
 * One thing the user can configure about the app itself.
 *
 * Deliberately not shaped around MCP: `summary` is whatever one line describes the current
 * state, and `attention` is whatever is wrong with it. A second entry - folder access is the
 * one this is waiting for - fills the same fields and needs no change here.
 */
interface CustomizeEntry {
  id: string;
  icon: ReactNode;
  label: string;
  /** Current state in one line, so the panel answers the easy question without a dialog. */
  summary: string;
  /** Set only when the entry needs the user; also surfaced on the shut Customize row. */
  attention?: string;
  onOpen: () => void;
}

function mcpEntry(controller: McpServersController, onOpen: () => void): CustomizeEntry {
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
    onOpen,
  };
}

/**
 * Light, dark or follow the OS - cycled in place rather than opened.
 *
 * Every other entry here opens a dialog, but a three-way choice with immediate, whole-window
 * feedback does not need one: the click repaints the app and rewrites this row's own summary,
 * which says what the setting now is more plainly than a dialog would. It sits in Customize
 * rather than on a logo because a logo that silently changes a setting is not a control -
 * nothing about it says it can be clicked, or what clicking it would do.
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
    onOpen: () => setMode(nextThemeMode(mode)),
  };
}

/**
 * Whether the composer offers a guess at the next message - toggled in place, like Appearance.
 *
 * A dialog would be a whole window for one boolean. What it does need is a place to be turned
 * OFF: it is on by default and it spends a model call per reply, so a user who does not want
 * either has to be able to find the switch. There is deliberately no third state - nothing here
 * makes a suggestion send itself.
 */
function suggestionsEntry(enabled: boolean, toggle: () => void): CustomizeEntry {
  return {
    id: 'prompt-suggestions',
    icon: <SparkIcon />,
    label: 'Suggested next prompt',
    summary: promptSuggestionsSummary(enabled),
    onOpen: toggle,
  };
}

function EntryRow({ entry }: { entry: CustomizeEntry }) {
  return (
    <Button
      fullWidth
      size="sm"
      variant="plain"
      color="neutral"
      startDecorator={<Box sx={{ color: 'text.tertiary', display: 'flex' }}>{entry.icon}</Box>}
      endDecorator={
        entry.attention ? (
          <Chip size="sm" variant="soft" color="danger" data-testid="customize-entry-attention">
            {entry.attention}
          </Chip>
        ) : undefined
      }
      onClick={entry.onOpen}
      sx={{ justifyContent: 'flex-start', pl: 2, '--Button-gap': '10px' }}
      data-testid="customize-entry-btn"
      data-entry={entry.id}
    >
      <Stack sx={{ flex: 1, minWidth: 0, alignItems: 'flex-start' }}>
        <Typography level="body-sm" noWrap sx={{ fontWeight: 'md' }}>
          {entry.label}
        </Typography>
        <Typography level="body-xs" textColor="text.tertiary" noWrap data-testid="customize-entry-summary">
          {entry.summary}
        </Typography>
      </Stack>
    </Button>
  );
}

/**
 * "Customize": where the app's own settings live, under the nav and shut by default.
 *
 * A collapsible list rather than a settings window, which is the shape the nav already uses for
 * Archived and the shape the reference has here. Shut it costs one row, which is the point -
 * MCP servers used to hold a permanent card in the sidebar for a control that is opened rarely,
 * and the failure count was the only part of that card worth the space. That part survives as
 * the entry's own `attention`, raised onto this row while the list is shut, so a dead server is
 * still noticeable without the panel being open.
 */
export function CustomizePanel() {
  const [open, setOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const mcp = useMcpServers();
  const { mode, setMode } = useColorScheme();
  const theme = useTheme();
  const [suggestions, toggleSuggestions] = usePromptSuggestions();

  const entries: CustomizeEntry[] = [
    appearanceEntry(mode, setMode, theme.palette.mode),
    suggestionsEntry(suggestions, toggleSuggestions),
    mcpEntry(mcp, () => setMcpOpen(true)),
  ];
  const attention = entries.find(entry => entry.attention)?.attention;

  return (
    <>
      <NavItem
        icon={<GearIcon />}
        label="Customize"
        onClick={() => setOpen(current => !current)}
        end={
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
            {!open && attention && (
              <Chip size="sm" variant="soft" color="danger" data-testid="customize-attention-chip">
                {attention}
              </Chip>
            )}
            <ChevronIcon open={open} />
          </Stack>
        }
        testId="chat-customize-btn"
      />

      {open && (
        <Stack spacing={0.25} data-testid="customize-panel">
          {entries.map(entry => (
            <EntryRow key={entry.id} entry={entry} />
          ))}
        </Stack>
      )}

      <McpServersDialog open={mcpOpen} onClose={() => setMcpOpen(false)} controller={mcp} />
    </>
  );
}
