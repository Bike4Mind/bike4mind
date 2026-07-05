import React from 'react';
import { Box } from 'ink';
import { ThoughtStream } from './ThoughtStream';
import { useCliStore } from '../store';

/**
 * Simple processing indicator shown while agent is thinking
 */
export const AgentThinking = React.memo(function AgentThinking() {
  // Selective subscription - only this component re-renders on step changes
  const isThinking = useCliStore(state => state.isThinking);

  if (!isThinking) {
    return null;
  }

  return (
    <Box paddingX={1} marginBottom={1}>
      <ThoughtStream isThinking={isThinking} />
    </Box>
  );
});
