import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { useElapsedTimer } from '../hooks/useElapsedTimer';

interface ThoughtStreamProps {
  isThinking: boolean;
}

export const ThoughtStream = React.memo(function ThoughtStream({ isThinking }: ThoughtStreamProps) {
  const { elapsed, isVisible } = useElapsedTimer(isThinking);

  return (
    <Box flexDirection="column">
      {/* Show spinner only if no final answer */}
      {isThinking && (
        <Box>
          <Text color="yellow">
            <Spinner type="dots" />
          </Text>
          <Text> Thinking...{isVisible ? <Text dimColor> ({elapsed}s)</Text> : null}</Text>
        </Box>
      )}
    </Box>
  );
});
