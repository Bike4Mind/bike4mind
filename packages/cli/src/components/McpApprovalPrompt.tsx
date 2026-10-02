import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import type { PendingMcpApproval } from '../storage/ConfigStore';
import { escapeTerminalControlChars } from './PermissionPrompt';

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

// Each repo field renders on one line, so tab/newline are escaped too (the shared
// helper keeps them for multi-line previews); otherwise a value could fake a prompt line.
const displaySafe = (s: string) =>
  escapeTerminalControlChars(s).replace(/[\t\n]/g, c => (c === '\n' ? '\\x0a' : '\\x09'));

const displayArg = (a: string) => (/[\s"']/.test(a) ? JSON.stringify(displaySafe(a)) : displaySafe(a));

/**
 * Startup prompt for repo-discovered MCP servers (trusted project) whose exact
 * definition hasn't been approved. Shows env/header KEY names; values only for
 * loader-style env keys (PATH, NODE_OPTIONS, LD_*, ...) that change what runs.
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
        <Text dimColor>{displaySafe(projectRoot)}</Text>
      </Box>

      <Box marginBottom={1} flexDirection="column">
        {servers.map(s => (
          <Box key={s.name} flexDirection="column" marginBottom={1}>
            <Text bold>{displaySafe(s.name)}</Text>
            <Text>
              {s.url !== undefined
                ? displaySafe(s.url)
                : [s.command, ...(s.args ?? [])]
                    .filter((p): p is string => p !== undefined)
                    .map(displayArg)
                    .join(' ')}
            </Text>
            {s.envKeys.length > 0 && (
              <Text dimColor>
                env:{' '}
                {s.envKeys
                  .map(k => (k in s.envValues ? displaySafe(`${k}=${s.envValues[k]}`) : displaySafe(k)))
                  .join(', ')}
              </Text>
            )}
            {s.headerKeys.length > 0 && <Text dimColor>headers: {s.headerKeys.map(displaySafe).join(', ')}</Text>}
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
