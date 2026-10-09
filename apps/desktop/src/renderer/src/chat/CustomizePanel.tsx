import Box from '@mui/joy/Box';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { entryAttentionChip, EntrySection, type ConfigEntry } from './ConfigEntry';
import { CloseIcon, ServerIcon, SlidersIcon } from './icons';
import { McpServersSettings } from './McpServersSettings';
import { NavItem } from './SessionList';
import { columnStackSx, contentColumnSx, scrollingColumnHostSx } from './layout';
import { useMcpServers, type McpServersController } from './useMcpServers';

/** What this screen is for, said on the screen so it does not have to be inferred from a name. */
const CUSTOMIZE_INTRO = 'What tools the app can reach.';

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

/**
 * Every tool setting, built once and read by both the nav row and the screen.
 *
 * The row needs only `attention` out of this, but it has to come from the same list the screen
 * draws or the badge would be answering a different question from the section it points at.
 * MCP is now the only entry here that can raise one; the chip still honours `attentionColor`,
 * since what the row has to say about an entry is the entry's to decide.
 */
function useCustomizeEntries(): ConfigEntry[] {
  const mcp = useMcpServers();
  return [mcpEntry(mcp)];
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
 * "Customize": what tools the app can reach, as a screen beside Artifacts.
 *
 * Each setting is on the page rather than behind a row that opens something else. A list of
 * three links that each lead somewhere would be a navigation step bought with a whole screen -
 * strictly worse than the one-row collapse it replaces - so the screen shows the controls
 * themselves and MCP, the one that used to need a window, is a section like the rest.
 *
 * App preferences, the server and updates are Settings. The two screens say which half they own
 * under their titles, so neither has to be searched for the other's half.
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
