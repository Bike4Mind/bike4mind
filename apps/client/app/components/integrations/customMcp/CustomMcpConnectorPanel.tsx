import { useState } from 'react';
import { Box, Button, Skeleton, Stack, Typography } from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import type { IMcpConnectionPublic, McpPresetId } from '@bike4mind/common';
import { useMcpConnections } from '@client/app/hooks/data/mcpConnections';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import AddMcpConnectorForm from './AddMcpConnectorForm';
import McpConnectionItem from './McpConnectionItem';
import { connectionsFor } from './customMcpModel';

/**
 * The integrations drawer body for custom MCP connectors: the user's connections with their
 * manage actions, and the add form. With `presetId` it manages that preset's connection only and
 * offers the add form while there is none.
 */
const CustomMcpConnectorPanel = ({ presetId, presetName }: { presetId?: McpPresetId; presetName?: string }) => {
  const impersonating = useAccessToken(s => s.impersonating);
  const { isFeatureEnabled } = useAdminSettingsCache();
  const enabled = isFeatureEnabled('EnableCustomMcpConnectors');
  const { data, isPending, isError, refetch } = useMcpConnections({ enabled });
  const connections = connectionsFor(data ?? [], presetId);
  const [adding, setAdding] = useState(false);
  // The connection just added: it opens on its tool review.
  const [justAdded, setJustAdded] = useState<string | null>(null);

  // The list query is off while impersonating, so it would stay pending forever.
  if (impersonating) {
    return (
      <Typography level="body-sm" sx={{ color: 'text.secondary' }} data-testid="custom-mcp-panel-impersonating">
        Custom connectors are not shown while impersonating a user.
      </Typography>
    );
  }
  if (!enabled) {
    return (
      <Typography level="body-sm" data-testid="custom-mcp-panel-disabled">
        Turn on EnableCustomMcpConnectors in Admin settings to use custom connectors.
      </Typography>
    );
  }
  if (isPending) {
    return (
      <Stack gap="8px" data-testid="custom-mcp-panel-loading">
        <Skeleton variant="rectangular" height={72} sx={{ borderRadius: '8px' }} />
      </Stack>
    );
  }
  if (isError) {
    return (
      <Stack gap="8px" alignItems="flex-start" data-testid="custom-mcp-panel-error">
        <Typography level="body-sm" color="danger">
          Could not load your connectors.
        </Typography>
        <Button size="sm" variant="outlined" color="neutral" onClick={() => void refetch()}>
          Try again
        </Button>
      </Stack>
    );
  }

  const onCreated = (connection: IMcpConnectionPublic) => {
    setAdding(false);
    setJustAdded(connection.id);
  };

  const showForm = adding || connections.length === 0;
  const canAddMore = !presetId;

  return (
    <Stack gap="16px" data-testid="custom-mcp-panel">
      {connections.length > 0 && (
        <Stack gap="8px">
          <Typography level="title-sm">{presetId ? 'Your connection' : 'Your connectors'}</Typography>
          {connections.map(connection => (
            <McpConnectionItem
              key={connection.id}
              connection={connection}
              reviewOnMount={connection.id === justAdded}
            />
          ))}
        </Stack>
      )}

      {showForm ? (
        <Box>
          {connections.length > 0 && (
            <Typography level="title-sm" sx={{ mb: '8px' }}>
              Add a connector
            </Typography>
          )}
          <AddMcpConnectorForm
            presetId={presetId}
            presetName={presetName}
            onCreated={onCreated}
            onCancel={connections.length > 0 ? () => setAdding(false) : undefined}
          />
        </Box>
      ) : (
        canAddMore && (
          <Box>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              startDecorator={<AddIcon />}
              onClick={() => setAdding(true)}
              data-testid="custom-mcp-add-btn"
            >
              Add connector
            </Button>
          </Box>
        )
      )}
      <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
        New or changed tools stay off until you review them. Tools that can change data ask before each call unless you
        choose otherwise.
      </Typography>
    </Stack>
  );
};

export default CustomMcpConnectorPanel;
