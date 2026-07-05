import React from 'react';
import { Box, Text } from 'ink';
import * as path from 'node:path';
import type { FileSearchResult } from '../utils/fileSearch.js';
import { formatFileSize } from '../utils/fileSearch.js';

interface FileAutocompleteProps {
  files: FileSearchResult[];
  selectedIndex: number;
  query: string;
}

export function FileAutocomplete({ files, selectedIndex, query }: FileAutocompleteProps) {
  if (files.length === 0) {
    // Helpful message for absolute paths with no results
    if (path.isAbsolute(query)) {
      return (
        <Box marginLeft={2} marginTop={1}>
          <Text dimColor>No items in </Text>
          <Text color="cyan">{query}</Text>
          <Text dimColor> (or path does not exist)</Text>
        </Box>
      );
    }

    return (
      <Box marginLeft={2} marginTop={1}>
        <Text dimColor>No matching files{query ? ` for "${query}"` : ' in root directory'}</Text>
      </Box>
    );
  }

  // Display max 6 results at a time (like Claude Code)
  const VIEWPORT_SIZE = 6;
  const totalFiles = files.length;

  // Calculate viewport window (show 6 results centered around selected item)
  let startIndex = 0;
  let endIndex = Math.min(VIEWPORT_SIZE, totalFiles);

  if (totalFiles > VIEWPORT_SIZE) {
    // Try to center the selected item in the viewport
    const halfViewport = Math.floor(VIEWPORT_SIZE / 2);
    startIndex = Math.max(0, selectedIndex - halfViewport);
    endIndex = Math.min(totalFiles, startIndex + VIEWPORT_SIZE);

    // Adjust if we're at the end
    if (endIndex === totalFiles) {
      startIndex = Math.max(0, totalFiles - VIEWPORT_SIZE);
    }
  }

  const visibleFiles = files.slice(startIndex, endIndex);

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      <Box marginBottom={1}>
        <Text dimColor>
          {totalFiles === 1 ? '1 match' : `${totalFiles} matches`}
          {totalFiles > VIEWPORT_SIZE && ` (${selectedIndex + 1}/${totalFiles})`} - Use up/down to navigate, Tab to
          select
        </Text>
      </Box>
      {visibleFiles.map((file, viewportIndex) => {
        const actualIndex = startIndex + viewportIndex;
        const isSelected = actualIndex === selectedIndex;
        const icon = file.isDirectory ? '[folder]' : '[file]  ';
        const sizeDisplay = file.isDirectory ? '' : file.size !== undefined ? ` (${formatFileSize(file.size)})` : '';
        const pathDisplay = file.isDirectory ? `${file.path}/` : file.path;

        return (
          <Box key={file.path} marginLeft={1}>
            <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
              {isSelected ? '> ' : '  '}
            </Text>
            <Text color={file.isDirectory ? 'yellow' : isSelected ? 'cyan' : undefined} bold={isSelected}>
              {icon}
            </Text>
            <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
              {' '}
              {pathDisplay}
            </Text>
            <Text dimColor>{sizeDisplay}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
