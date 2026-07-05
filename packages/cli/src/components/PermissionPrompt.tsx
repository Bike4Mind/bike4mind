import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';

export type PermissionResponse = 'allow-once' | 'allow-session' | 'allow-always' | 'deny';

/** Render a diff/preview string, color-coding each line by its prefix (see per-branch comments below). */
function renderDiffPreview(preview: string): React.ReactNode {
  const lines = preview.split('\n');

  return lines.map((line, index) => {
    // Sandbox block header
    if (line.startsWith('🛑')) {
      return (
        <Text key={index} bold color="red">
          {line}
        </Text>
      );
    }

    // Additions (green)
    if (line.startsWith('+')) {
      return (
        <Text key={index} color="green">
          {line}
        </Text>
      );
    }

    // Bullet warnings (yellow for sandbox context)
    if (line.startsWith('- ')) {
      return (
        <Text key={index} color="yellow">
          {line}
        </Text>
      );
    }

    // Removals (red)
    if (line.startsWith('-')) {
      return (
        <Text key={index} color="red">
          {line}
        </Text>
      );
    }

    // Hunk headers (cyan) - also used for error detail sections
    if (line.startsWith('@@')) {
      return (
        <Text key={index} color="cyan">
          {line}
        </Text>
      );
    }

    // Context lines (dim)
    return (
      <Text key={index} dimColor>
        {line}
      </Text>
    );
  });
}

export interface PermissionPromptProps {
  toolName: string;
  toolDescription?: string;
  args: unknown;
  preview?: string;
  canBeTrusted: boolean; // Whether this tool can be trusted (not prompt_always)
  onResponse: (response: PermissionResponse) => void;
}

// Tools whose Arguments block is suppressed in the permission prompt.
// The Preview block still renders, so the user has the human-readable
// form to approve against.
const TOOLS_WITH_HIDDEN_ARGS = new Set(['edit_local_file', 'bash_execute']);

/**
 * Permission prompt component
 *
 * Displays when a tool needs permission before execution.
 * Waits indefinitely for user response (like Claude Code).
 */
export function PermissionPrompt({
  toolName,
  toolDescription,
  args,
  preview,
  canBeTrusted,
  onResponse,
}: PermissionPromptProps) {
  const hideArgs = TOOLS_WITH_HIDDEN_ARGS.has(toolName);
  // Build menu items based on whether tool can be trusted
  const items: Array<{ label: string; value: PermissionResponse }> = canBeTrusted
    ? [
        { label: '✓ Allow once', value: 'allow-once' },
        { label: '✓ Allow for this session', value: 'allow-session' },
        { label: '✓ Always allow (trust this tool)', value: 'allow-always' },
        { label: '✗ Deny', value: 'deny' },
      ]
    : [
        { label: '✓ Allow once', value: 'allow-once' },
        { label: '✓ Allow for this session', value: 'allow-session' },
        { label: '✗ Deny', value: 'deny' },
      ];

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [responded, setResponded] = useState(false);

  const handleSelect = useCallback(() => {
    if (responded) return;
    setResponded(true);
    onResponse(items[selectedIndex].value);
  }, [responded, onResponse, items, selectedIndex]);

  const handleSelectIndex = useCallback(
    (index: number) => {
      if (responded) return;
      setResponded(true);
      onResponse(items[index].value);
    },
    [responded, onResponse, items]
  );

  // Direct useInput with isActive - more resilient to parent re-renders
  // than ink-select-input which can lose its input handler
  useInput(
    (input, key) => {
      if (responded) return;

      // Number key shortcuts (1-based)
      const num = parseInt(input, 10);
      if (num >= 1 && num <= items.length) {
        handleSelectIndex(num - 1);
        return;
      }

      // y = Allow once (first option), n = Deny (last option)
      if (input.toLowerCase() === 'y') {
        handleSelectIndex(0);
        return;
      }
      if (input.toLowerCase() === 'n') {
        handleSelectIndex(items.length - 1);
        return;
      }

      if (key.upArrow) {
        setSelectedIndex(i => (i > 0 ? i - 1 : items.length - 1));
      } else if (key.downArrow) {
        setSelectedIndex(i => (i < items.length - 1 ? i + 1 : 0));
      } else if (key.return) {
        handleSelect();
      }
    },
    { isActive: !responded }
  );

  // Format arguments for display with truncation
  const MAX_ARGS_LENGTH = 500;
  const rawArgsString = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
  const argsString =
    rawArgsString.length > MAX_ARGS_LENGTH
      ? rawArgsString.slice(0, MAX_ARGS_LENGTH) + `\n... (${rawArgsString.length - MAX_ARGS_LENGTH} more chars)`
      : rawArgsString;

  const isSandboxBlock = preview?.startsWith('🛑');
  const borderColor = isSandboxBlock ? 'red' : 'yellow';
  const headerColor = isSandboxBlock ? 'red' : 'yellow';
  const headerText = isSandboxBlock ? '🛑 Sandbox Blocked' : '⚠️ Permission Required';

  return (
    <Box flexDirection="column" borderStyle="bold" borderColor={borderColor} padding={1} marginY={1}>
      <Box>
        <Text bold color={headerColor}>
          {headerText}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Tool: </Text>
        <Text bold color="cyan">
          {toolName}
        </Text>
      </Box>

      {toolDescription && (
        <Box>
          <Text dimColor>Action: </Text>
          <Text>{toolDescription}</Text>
        </Box>
      )}

      {!hideArgs && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Arguments:</Text>
          <Box paddingLeft={2} flexDirection="column">
            <Text dimColor>{argsString}</Text>
          </Box>
        </Box>
      )}

      {preview && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Preview:</Text>
          <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column">
            {renderDiffPreview(preview)}
          </Box>
        </Box>
      )}

      {!canBeTrusted && (
        <Box marginTop={1}>
          <Text color="red" dimColor>
            Note: This tool cannot be trusted due to its dangerous nature.
          </Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        {items.map((item, index) => (
          <Box key={item.value}>
            <Text color="cyan">{index + 1}.</Text>
            <Text color={index === selectedIndex ? 'cyan' : undefined} bold={index === selectedIndex}>
              {index === selectedIndex ? ' ❯ ' : '   '}
              {item.label}
            </Text>
          </Box>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Press 1-{items.length}, y/n, or ↑↓ + Enter</Text>
      </Box>
    </Box>
  );
}
