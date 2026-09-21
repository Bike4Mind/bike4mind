import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';

export type FolderTrustChoice = 'trust' | 'not-now';

interface FolderTrustPromptProps {
  projectRoot: string;
  onSelect: (choice: FolderTrustChoice) => void;
}

type FolderTrustItem = {
  label: string;
  value: FolderTrustChoice;
};

/**
 * One-time startup prompt shown when the current project root ships repo-committed
 * b4m files (config, .mcp.json, agents, skills, commands) but has not been
 * trusted. Until trusted, those files are inert - no config merge, no MCP spawn,
 * no agent/skill/command load. "Trust this folder" persists the decision; "Not
 * now" keeps the project untrusted for this session (re-prompts next launch).
 *
 * "Not now" is listed first so it is the preselected default: Enter-through on a
 * freshly cloned repo must not grant trust.
 */
export function FolderTrustPrompt({ projectRoot, onSelect }: FolderTrustPromptProps) {
  const items: FolderTrustItem[] = [
    { label: 'Not now - keep repo config inert this session', value: 'not-now' },
    { label: 'Trust this folder - load its config, agents, skills and MCP servers', value: 'trust' },
  ];

  return (
    <Box flexDirection="column" marginY={1}>
      <Box marginBottom={1} flexDirection="column">
        <Text bold color="yellow">
          This project ships Bike4Mind config that can run code.
        </Text>
        <Text dimColor>{projectRoot}</Text>
        <Text>
          Repo-committed config, MCP servers, agents and skills stay inert until you trust this folder. Only trust
          folders you would run code from.
        </Text>
      </Box>

      <SelectInput
        items={items}
        onSelect={item => onSelect(item.value)}
        itemComponent={({ isSelected, label }) => (
          <Box>
            <Text color={isSelected ? 'cyan' : undefined}>
              {isSelected ? '❯ ' : '  '}
              {label}
            </Text>
          </Box>
        )}
      />

      <Box marginTop={1}>
        <Text dimColor>Use ↑↓ arrows to navigate, Enter to select. You can change this later with /trust folder.</Text>
      </Box>
    </Box>
  );
}
