import React, { useCallback, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface ExitHandoffPromptProps {
  onResponse: (generate: boolean) => void;
}

/**
 * Single-shot y/n prompt shown on exit when the session is eligible for a
 * handoff (meaningful content, no existing handoff). Defaults to "yes" on
 * Enter so the common case (preserve continuity) is one keystroke away.
 */
export function ExitHandoffPrompt({ onResponse }: ExitHandoffPromptProps) {
  // Ref guard - `useState` updates async, so back-to-back keystrokes in the
  // same tick would all see `responded === false` and fire multiple times.
  // The ref is the source of truth; state drives `isActive` for the next render.
  const respondedRef = useRef(false);
  const [responded, setResponded] = useState(false);

  const respond = useCallback(
    (generate: boolean) => {
      if (respondedRef.current) return;
      respondedRef.current = true;
      setResponded(true);
      onResponse(generate);
    },
    [onResponse]
  );

  useInput(
    (input, key) => {
      if (respondedRef.current) return;
      const lower = input.toLowerCase();
      if (lower === 'y' || key.return) {
        respond(true);
      } else if (lower === 'n' || key.escape) {
        respond(false);
      }
    },
    { isActive: !responded }
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
      <Text bold color="cyan">
        🤝 Generate a handoff for this session before exiting? (Y/n)
      </Text>
      <Text dimColor>The handoff captures key findings, next steps, and open blockers.</Text>
    </Box>
  );
}
