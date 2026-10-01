import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import type { PendingMcpApproval } from '../storage/ConfigStore';

export type McpApprovalChoice = 'approve' | 'skip';

interface McpApprovalPromptProps {
  projectRoot: string;
  servers: PendingMcpApproval[];
  onSelect: (choice: McpApprovalChoice) => void;
}

type McpApprovalItem = {
  label: string;
  value: McpApprovalChoice;
};

/**
 * Startup prompt for repo-discovered MCP servers (trusted project) whose exact
 * definition hasn't been approved. Shows env/header KEY names only, never values.
 * "Approve all" persists each definition's fingerprint (a changed definition asks
 * again); "Skip" persists nothing, so they stay off and re-prompt next launch.
 *
 * "Skip" is listed first so Enter-through never starts a server. Sibling of
 * FolderTrustPrompt.
 */
export function McpApprovalPrompt({ projectRoot, servers, onSelect }: McpApprovalPromptProps) {
  const items: McpApprovalItem[] = [
    { label: "Skip - don't start these this session", value: 'skip' },
    { label: 'Approve all - start these servers (asks again if they change)', value: 'approve' },
  ];

  return (
    <Box flexDirection="column" marginY={1}>
      <Box marginBottom={1} flexDirection="column">
        <Text bold color="yellow">
          This project defines MCP servers that will run code on your machine.
        </Text>
        <Text dimColor>{projectRoot}</Text>
      </Box>

      <Box marginBottom={1} flexDirection="column">
        {servers.map(s => (
          <Box key={s.name} flexDirection="column" marginBottom={1}>
            <Text bold>{s.name}</Text>
            <Text>{s.url ?? [s.command, ...(s.args ?? [])].join(' ')}</Text>
            {s.envKeys.length > 0 && <Text dimColor>env: {s.envKeys.join(', ')}</Text>}
            {s.headerKeys.length > 0 && <Text dimColor>headers: {s.headerKeys.join(', ')}</Text>}
          </Box>
        ))}
      </Box>

      <SelectInput
        items={items}
        onSelect={item => onSelect(item.value)}
        itemComponent={({ isSelected, label }) => (
          <Box>
            <Text color={isSelected ? 'cyan' : undefined}>
              {isSelected ? '\u276F ' : '  '}
              {label}
            </Text>
          </Box>
        )}
      />

      <Box marginTop={1}>
        <Text dimColor>{'Use \u2191\u2193 arrows to navigate, Enter to select.'}</Text>
      </Box>
    </Box>
  );
}
