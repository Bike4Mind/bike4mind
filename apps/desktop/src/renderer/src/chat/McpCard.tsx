import { useState } from 'react';
import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { ServerIcon } from './icons';
import { McpServersDialog } from './McpServersDialog';
import { useMcpServers } from './useMcpServers';

/**
 * The sidebar's way in to the MCP servers, and the only place their health is visible at rest.
 *
 * It shows a count rather than a list because the count is the thing that is wrong when
 * something is wrong: "2 servers, 1 failed" is what a user needs to notice without opening
 * anything, and a failed server is otherwise indistinguishable from one that simply has no
 * tools. Always present, unlike SidebarCard, since it is a control and not a prompt.
 */
export function McpCard() {
  const controller = useMcpServers();
  const [open, setOpen] = useState(false);

  const connected = controller.servers.filter(server => server.status === 'connected').length;
  const failed = controller.servers.filter(server => server.status === 'failed').length;
  const tools = controller.servers.reduce((total, server) => total + server.tools.length, 0);

  const summary = (() => {
    if (controller.loading) return 'Loading...';
    if (controller.servers.length === 0) return 'None configured';
    if (connected === 0 && failed === 0) return `${controller.servers.length} configured`;
    return `${connected} connected, ${tools} ${tools === 1 ? 'tool' : 'tools'}`;
  })();

  return (
    <>
      <Sheet
        variant="soft"
        sx={{ m: 1, p: 1, borderRadius: 'sm', cursor: 'pointer' }}
        onClick={() => setOpen(true)}
        role="button"
        tabIndex={0}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') setOpen(true);
        }}
        data-testid="mcp-card"
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Box sx={{ color: 'text.tertiary', display: 'flex' }}>
            <ServerIcon />
          </Box>
          <Stack sx={{ flex: 1, minWidth: 0 }}>
            <Typography level="body-xs" sx={{ fontWeight: 'lg' }}>
              MCP servers
            </Typography>
            <Typography level="body-xs" textColor="text.tertiary" noWrap data-testid="mcp-card-summary">
              {summary}
            </Typography>
          </Stack>
          {failed > 0 && (
            <Chip size="sm" variant="soft" color="danger" data-testid="mcp-card-failed">
              {failed} failed
            </Chip>
          )}
        </Stack>
      </Sheet>

      <McpServersDialog open={open} onClose={() => setOpen(false)} controller={controller} />
    </>
  );
}
