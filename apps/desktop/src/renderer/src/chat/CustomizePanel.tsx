import { useState, type ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { ChevronIcon, GearIcon, ServerIcon } from './icons';
import { McpServersDialog } from './McpServersDialog';
import { NavItem } from './SessionList';
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

  const entries: CustomizeEntry[] = [mcpEntry(mcp, () => setMcpOpen(true))];
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
