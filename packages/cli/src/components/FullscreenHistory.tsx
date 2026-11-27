import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Message } from '../storage';
import { sanitizeTerminalText } from '../utils/sanitizeTerminalText.js';
import wrapAnsi from 'wrap-ansi';

export function FullscreenHistory({ messages, rows, columns }: { messages: Message[]; rows: number; columns: number }) {
  const [selected, setSelected] = useState(Math.max(0, messages.length - 1));
  const [offset, setOffset] = useState(0);
  const index = Math.min(selected, Math.max(0, messages.length - 1));
  const message = messages[index];
  const lines = useMemo(() => {
    if (!message) return ['No completed messages yet.'];
    const steps = message.metadata?.steps?.map(step => JSON.stringify(step)).join('\n');
    const transcript = [message.content, steps].filter(Boolean).join('\n\n');
    return wrapAnsi(sanitizeTerminalText(transcript), Math.max(1, columns), { hard: true }).split('\n');
  }, [message, columns]);
  const pageRows = Math.max(1, rows - 3);
  const start = Math.min(offset, Math.max(0, lines.length - pageRows));
  useInput((_input, key) => {
    if (key.leftArrow || key.rightArrow) {
      setSelected(Math.max(0, Math.min(messages.length - 1, index + (key.leftArrow ? -1 : 1))));
      setOffset(0);
    }
    if (key.upArrow || key.pageUp) setOffset(Math.max(0, start - (key.pageUp ? pageRows : 1)));
    if (key.downArrow || key.pageDown)
      setOffset(Math.min(Math.max(0, lines.length - pageRows), start + (key.pageDown ? pageRows : 1)));
  });
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate">
        History {messages.length ? index + 1 : 0}/{messages.length} {message?.role}
      </Text>
      <Text dimColor wrap="truncate">
        Left/Right: message | Up/Down/PgUp/PgDn: lines | Ctrl+O: back
      </Text>
      {lines.slice(start, start + pageRows).map((line, i) => (
        <Text key={i} wrap="truncate">
          {line || ' '}
        </Text>
      ))}
    </Box>
  );
}
