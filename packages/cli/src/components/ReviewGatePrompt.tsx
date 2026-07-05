import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { ReviewGateResponse } from '../tools/reviewGateTool';

export interface ReviewGatePromptProps {
  description: string;
  options?: string[];
  recommendation?: string;
  onResponse: (response: ReviewGateResponse) => void;
}

interface MenuItem {
  label: string;
  decision: 'approved' | 'rejected';
  withNote: boolean;
}

const ITEMS: readonly MenuItem[] = [
  { label: '✓ Approve', decision: 'approved', withNote: false },
  { label: '✓ Approve with note...', decision: 'approved', withNote: true },
  { label: '✗ Reject', decision: 'rejected', withNote: false },
  { label: '✗ Reject with note...', decision: 'rejected', withNote: true },
];

/**
 * Review gate prompt component.
 *
 * Pauses the agent and asks the user to explicitly approve or reject a
 * significant decision. An optional free-text note can be attached to either
 * decision via the dedicated "...with note..." actions.
 *
 * Keyboard:
 * - 1-4: shortcut for each action
 * - y: Approve (no note); n: Reject (no note)
 * - up/down: navigate; Enter: confirm selection
 * - When a "with note..." action is selected, an inline text input appears.
 *   Type the note and press Enter to submit. Use up/down to switch to a no-note
 *   action without losing the typed note.
 */
export function ReviewGatePrompt({ description, options, recommendation, onResponse }: ReviewGatePromptProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [note, setNote] = useState('');
  const [responded, setResponded] = useState(false);

  const submit = useCallback(
    (item: MenuItem, noteText: string) => {
      if (responded) return;
      setResponded(true);
      const trimmed = noteText.trim();
      onResponse({
        decision: item.decision,
        note: trimmed.length > 0 ? trimmed : undefined,
      });
    },
    [responded, onResponse]
  );

  const selectedItem = ITEMS[selectedIndex];
  const noteMode = selectedItem.withNote;

  const handleConfirm = useCallback(() => {
    if (selectedItem.withNote && note.trim().length === 0) {
      // The user explicitly chose a "with note" action but hasn't typed one.
      // Refuse to submit silently; up/down switches to a no-note action.
      return;
    }
    submit(selectedItem, note);
  }, [selectedItem, note, submit]);

  // While in note mode, the inline TextInput owns printable keys + Enter.
  // We still handle arrows so the user can navigate away without losing
  // their typed note.
  useInput(
    (input, key) => {
      if (responded) return;

      if (key.upArrow) {
        setSelectedIndex(i => (i > 0 ? i - 1 : ITEMS.length - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex(i => (i < ITEMS.length - 1 ? i + 1 : 0));
        return;
      }

      if (noteMode) return;

      // Number shortcuts (1-based)
      const num = parseInt(input, 10);
      if (num >= 1 && num <= ITEMS.length) {
        const item = ITEMS[num - 1];
        setSelectedIndex(num - 1);
        if (!item.withNote) submit(item, '');
        return;
      }

      // y/n short circuits to the no-note variants
      if (input.toLowerCase() === 'y') {
        submit(ITEMS[0], '');
        return;
      }
      if (input.toLowerCase() === 'n') {
        submit(ITEMS[2], '');
        return;
      }

      if (key.return) handleConfirm();
    },
    { isActive: !responded }
  );

  if (responded) return null;

  return (
    <Box flexDirection="column" borderStyle="bold" borderColor="magenta" padding={1} marginY={1}>
      <Box>
        <Text bold color="magenta">
          🛑 Review Gate
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text>{description}</Text>
      </Box>

      {recommendation && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Recommendation:</Text>
          <Box paddingLeft={2}>
            <Text dimColor>{recommendation}</Text>
          </Box>
        </Box>
      )}

      {options && options.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Options:</Text>
          <Box paddingLeft={2} flexDirection="column">
            {options.map((opt, idx) => (
              <Text key={idx} dimColor>
                • {opt}
              </Text>
            ))}
          </Box>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        {ITEMS.map((item, index) => {
          const isHighlighted = index === selectedIndex;
          const color = item.decision === 'approved' ? 'green' : 'red';
          return (
            <Box key={item.label}>
              <Text color="cyan">{index + 1}.</Text>
              <Text color={isHighlighted ? color : undefined} bold={isHighlighted}>
                {isHighlighted ? ' ❯ ' : '   '}
                {item.label}
              </Text>
            </Box>
          );
        })}
      </Box>

      {noteMode && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Note:</Text>
          <Box paddingLeft={2}>
            <TextInput
              value={note}
              onChange={setNote}
              onSubmit={handleConfirm}
              placeholder="Type a note and press Enter…"
            />
          </Box>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {noteMode
            ? note.trim().length === 0
              ? 'Note required — type a note + Enter to submit, ↑↓ to switch action'
              : 'Type note + Enter to submit, ↑↓ to switch action'
            : 'Press 1-4, y/n, or ↑↓ + Enter'}
        </Text>
      </Box>
    </Box>
  );
}
