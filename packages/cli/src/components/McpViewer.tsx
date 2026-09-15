import React, { useEffect, useReducer } from 'react';
import { Box, Text, useInput } from 'ink';
import type { CliConfig } from '../storage';
import type { McpManager } from '../utils/mcpAdapter';

export interface McpViewerProps {
  config: CliConfig;
  mcpManager?: McpManager;
  onClose: () => void;
}

/**
 * Full-screen MCP server status viewer
 *
 * Features:
 * - Shows configured MCP servers (enabled/disabled)
 * - Shows connection status (connecting/connected/failed) - live-updating
 * - Shows available tools from connected servers
 * - q or Escape to close
 */
export function McpViewer({ config, mcpManager, onClose }: McpViewerProps) {
  // Re-render whenever a background MCP connection settles
  const [, forceUpdate] = useReducer(x => x + 1, 0);
  useEffect(() => {
    if (!mcpManager) return;
    mcpManager.setOnStateChange(forceUpdate);
    return () => mcpManager.setOnStateChange(() => {});
  }, [mcpManager]);

  // Handle keyboard input
  useInput((input, key) => {
    // Close on Escape or 'q'
    if (key.escape || input === 'q') {
      onClose();
    }
  });

  // No MCP servers configured
  if (config.mcpServers.length === 0) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            📡 MCP Server Status
          </Text>
        </Box>

        <Text dimColor>No MCP servers configured.</Text>
        <Box marginTop={1}>
          <Text dimColor>To add MCP servers, edit your config file:</Text>
        </Box>
        <Text dimColor> Global: ~/.bike4mind/config.json</Text>
        <Text dimColor> Project: .bike4mind/config.json</Text>

        <Box marginTop={2}>
          <Text dimColor italic>
            Press Esc or q to close
          </Text>
        </Box>
      </Box>
    );
  }

  // Get enabled servers
  const enabledServers = config.mcpServers.filter(s => s.enabled);

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          📡 MCP Server Status
        </Text>
      </Box>

      {/* Configured Servers */}
      <Box flexDirection="column" marginBottom={2}>
        <Text bold dimColor>
          Configured Servers:
        </Text>

        {config.mcpServers.map(server => {
          const status = server.enabled ? '✅ Enabled' : '⏸️  Disabled';
          const commandInfo = server.command ? `${server.command} ${(server.args || []).join(' ')}` : '(internal)';

          return (
            <Box key={server.name} flexDirection="column" marginTop={1} marginLeft={2}>
              <Text>
                • <Text bold>{server.name}</Text> - <Text dimColor>{status}</Text>
              </Text>
              <Text dimColor> Command: {commandInfo}</Text>
              {Object.keys(server.env).length > 0 && (
                <Text dimColor> Env vars: {Object.keys(server.env).join(', ')}</Text>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Connection Status */}
      {enabledServers.length > 0 && mcpManager && (
        <Box flexDirection="column" marginBottom={2}>
          <Text bold dimColor>
            Connection Status:
          </Text>

          {enabledServers.map(server => {
            const state = mcpManager.getConnectionState(server.name);
            let icon: string;
            let statusText: string;
            let color: 'green' | 'yellow' | 'red' | 'gray';

            switch (state) {
              case 'connected':
                icon = '✔';
                statusText = 'connected';
                color = 'green';
                break;
              case 'connecting':
                icon = '◯';
                statusText = 'connecting…';
                color = 'yellow';
                break;
              case 'failed':
                icon = '✗';
                statusText = 'failed';
                color = 'red';
                break;
              default:
                icon = '◯';
                statusText = 'connecting…';
                color = 'gray';
            }

            // Get tool count for connected servers
            const toolCounts = mcpManager.getToolCount();
            const serverTools = toolCounts.find(t => t.serverName === server.name);
            const toolCount = serverTools?.count || 0;
            const toolInfo =
              state === 'connected' && toolCount > 0 ? ` (${toolCount} tool${toolCount === 1 ? '' : 's'})` : '';

            return (
              <Box key={server.name} marginTop={1} marginLeft={2}>
                <Text>
                  • <Text bold>{server.name}</Text> · <Text color={color}>{icon}</Text>{' '}
                  <Text color={color}>{statusText}</Text>
                  {toolInfo && <Text dimColor>{toolInfo}</Text>}
                </Text>
              </Box>
            );
          })}

          {/* Total tools */}
          <Box marginTop={1} marginLeft={2}>
            {(() => {
              const toolCounts = mcpManager.getToolCount();
              const totalTools = toolCounts.reduce((sum, s) => sum + s.count, 0);

              if (totalTools > 0) {
                return (
                  <Text bold color="green">
                    Total: {totalTools} MCP tool{totalTools === 1 ? '' : 's'} available
                  </Text>
                );
              } else {
                return <Text dimColor>No MCP tools available yet (servers still connecting)</Text>;
              }
            })()}
          </Box>
        </Box>
      )}

      {/* No enabled servers */}
      {enabledServers.length === 0 && (
        <Box marginBottom={2}>
          <Text color="yellow">⚠️ No MCP servers enabled</Text>
          <Text dimColor> Use `b4m mcp enable {'<name>'}` to enable a server</Text>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor italic>
          Press Esc or q to close
        </Text>
      </Box>
    </Box>
  );
}
