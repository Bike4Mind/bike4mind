import { useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import type { IMcpConnectionPublic } from '@bike4mind/common';
import AddMcpConnectorForm from '@client/app/components/integrations/customMcp/AddMcpConnectorForm';
import McpConnectionItem from '@client/app/components/integrations/customMcp/McpConnectionItem';
import { usePlatformMcpConnections } from '@client/app/hooks/data/mcpConnections';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import { AdminPageHeader, EmptyState, ErrorState, LoadingState } from './shared';
import { adminFocus } from './shared/adminStyles';
import { AdminPermissionAction } from './shared/MissingPermission';

/** Platform MCP connectors: set up once by an admin, offered in every user's Tools menu. */
const PlatformMcpConnectorsSection = () => {
  const impersonating = useAccessToken(s => s.impersonating);
  const { isFeatureEnabled } = useAdminSettingsCache();
  const { data, isPending, isError, isRefetching, refetch } = usePlatformMcpConnections();
  const [adding, setAdding] = useState(false);
  // The connector just added: it opens on its tool review.
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const connections = data ?? [];
  const featureOff = !isFeatureEnabled('EnableMCPServer') || !isFeatureEnabled('EnableCustomMcpConnectors');

  const onCreated = (connection: IMcpConnectionPublic) => {
    setAdding(false);
    setJustAdded(connection.id);
  };

  const addButton = (
    <AdminPermissionAction requirement="settings:manage">
      {disabled => (
        <Button
          size="sm"
          variant="outlined"
          startDecorator={<AddIcon />}
          disabled={disabled || adding}
          onClick={() => setAdding(true)}
          data-testid="platform-mcp-add-btn"
          sx={adminFocus}
        >
          Add connector
        </Button>
      )}
    </AdminPermissionAction>
  );

  const body = () => {
    if (impersonating) {
      return (
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="platform-mcp-impersonating">
          Platform connectors are not shown while impersonating a user.
        </Typography>
      );
    }
    if (isPending) return <LoadingState label="Loading connectors" testId="platform-mcp-loading" />;
    if (isError) {
      return (
        <ErrorState
          message="Could not load the platform connectors."
          onRetry={() => void refetch()}
          retrying={isRefetching}
        />
      );
    }
    return (
      <Stack gap={1.5}>
        {connections.length === 0 && !adding && (
          <EmptyState
            title="No platform connectors yet"
            description="Add one to offer its tools to every user."
            action={addButton}
          />
        )}
        {connections.map(connection => (
          <McpConnectionItem
            key={connection.id}
            connection={connection}
            scope="platform"
            reviewOnMount={connection.id === justAdded}
          />
        ))}
        {adding && (
          <Box data-testid="platform-mcp-add">
            <Typography level="title-sm" sx={{ mb: 1 }}>
              Add a platform connector
            </Typography>
            <AddMcpConnectorForm scope="platform" onCreated={onCreated} onCancel={() => setAdding(false)} />
          </Box>
        )}
      </Stack>
    );
  };

  return (
    <Stack component="section" gap={1.5} sx={{ maxWidth: '64rem' }} data-testid="platform-mcp-section">
      <AdminPageHeader
        level="section"
        title="Connectors"
        count={data?.length}
        description="A platform connector appears in every user's Tools menu switched off, and nothing of it reaches a chat until that user turns it on."
        actions={connections.length > 0 ? addButton : undefined}
      />
      {featureOff && (
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="platform-mcp-feature-off">
          Users see no connectors while EnableMCPServer or EnableCustomMcpConnectors is off in Admin settings, and new
          ones cannot be added.
        </Typography>
      )}
      {body()}
    </Stack>
  );
};

export default PlatformMcpConnectorsSection;
