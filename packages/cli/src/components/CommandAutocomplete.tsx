import React from 'react';
import { Box, Text } from 'ink';
import type { CommandDefinition } from '../config/commands.js';

interface CommandAutocompleteProps {
  commands: CommandDefinition[];
  selectedIndex: number;
}

export function CommandAutocomplete({ commands, selectedIndex }: CommandAutocompleteProps) {
  if (commands.length === 0) {
    return (
      <Box marginLeft={2} marginTop={1}>
        <Text dimColor>No matching commands</Text>
      </Box>
    );
  }

  // Display max 6 results at a time (like file autocomplete)
  const VIEWPORT_SIZE = 6;
  const totalCommands = commands.length;

  // Calculate viewport window (show 6 results centered around selected item)
  let startIndex = 0;
  let endIndex = Math.min(VIEWPORT_SIZE, totalCommands);

  if (totalCommands > VIEWPORT_SIZE) {
    // Try to center the selected item in the viewport
    const halfViewport = Math.floor(VIEWPORT_SIZE / 2);
    startIndex = Math.max(0, selectedIndex - halfViewport);
    endIndex = Math.min(totalCommands, startIndex + VIEWPORT_SIZE);

    // Adjust if we're at the end
    if (endIndex === totalCommands) {
      startIndex = Math.max(0, totalCommands - VIEWPORT_SIZE);
    }
  }

  const visibleCommands = commands.slice(startIndex, endIndex);

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      <Box marginBottom={1}>
        <Text dimColor>
          {totalCommands === 1 ? '1 command' : `${totalCommands} commands`}
          {totalCommands > VIEWPORT_SIZE && ` (${selectedIndex + 1}/${totalCommands})`} • Use ↑↓ to navigate, Enter to
          select
        </Text>
      </Box>
      {visibleCommands.map((cmd, viewportIndex) => {
        const actualIndex = startIndex + viewportIndex;
        const args = cmd.args ? ` ${cmd.args}` : '';
        const isSelected = actualIndex === selectedIndex;

        // Source indicator
        const sourceIcon =
          cmd.source === 'global' ? '🏠 ' : cmd.source === 'project' ? '📁 ' : cmd.source === 'built-in' ? '🔧 ' : '';

        return (
          <Box key={cmd.name} marginLeft={1}>
            <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
              {isSelected ? '▸ ' : '  '}
              {sourceIcon}/{cmd.name}
              {args} - {cmd.description}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
