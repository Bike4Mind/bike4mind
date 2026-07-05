import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import type { Message } from '../storage/types';

interface RewindSelectorProps {
  messages: Message[];
  onSelect: (messageIndex: number) => void;
  onCancel: () => void;
}

type RewindItem = {
  label: string;
  value: number;
};

type ConfirmationItem = {
  label: string;
  value: 'confirm' | 'cancel';
};

type Step = 'selection' | 'confirmation';

export function RewindSelector({ messages, onSelect, onCancel }: RewindSelectorProps) {
  const [step, setStep] = useState<Step>('selection');
  const [selectedMessageIndex, setSelectedMessageIndex] = useState<number | null>(null);

  // Handle Escape key for navigation
  useInput((input, key) => {
    if (key.escape) {
      if (step === 'confirmation') {
        // In confirmation step: go back to selection
        setStep('selection');
        setSelectedMessageIndex(null);
      } else {
        // In selection step: cancel operation
        onCancel();
      }
    }
  });

  // Get user messages only for selection
  const userMessages = messages
    .map((msg, idx) => ({ msg, originalIndex: idx }))
    .filter(({ msg }) => msg.role === 'user');

  // Create selection items (chronological order - oldest first)
  const items: RewindItem[] = userMessages.map(({ msg, originalIndex }, index) => {
    // Truncate content to 50 chars
    const preview = msg.content.length > 50 ? msg.content.substring(0, 50) + '...' : msg.content;
    const timestamp = new Date(msg.timestamp).toLocaleString();
    // Show position (1 = first/oldest message)
    const position = index + 1;
    return {
      label: `[${position}] ${timestamp} - ${preview}`,
      value: originalIndex,
    };
  });

  const handleSelectionSelect = (item: RewindItem) => {
    setSelectedMessageIndex(item.value);
    setStep('confirmation');
  };

  const handleConfirmationSelect = (item: ConfirmationItem) => {
    if (item.value === 'confirm' && selectedMessageIndex !== null) {
      onSelect(selectedMessageIndex);
    } else {
      // Go back to selection and reset selected index
      setStep('selection');
      setSelectedMessageIndex(null);
    }
  };

  // Calculate what will be removed for confirmation (with bounds checking)
  // This includes the selected message and everything after it
  const messagesToRemove =
    selectedMessageIndex !== null && selectedMessageIndex >= 0 && selectedMessageIndex < messages.length
      ? messages.slice(selectedMessageIndex)
      : [];
  const tokensToRemove = messagesToRemove.reduce((sum, msg) => {
    return sum + (msg.metadata?.tokenUsage?.total || 0);
  }, 0);

  if (step === 'selection') {
    return (
      <Box flexDirection="column" marginY={1}>
        <Box marginBottom={1}>
          <Text bold>Select a point to rewind to:</Text>
        </Box>

        <SelectInput
          items={items}
          onSelect={handleSelectionSelect}
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
          <Text dimColor>Use ↑↓ arrows to navigate, Enter to select, Esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  // Confirmation step
  const confirmationItems: ConfirmationItem[] = [
    { label: 'Yes, rewind to this point', value: 'confirm' },
    { label: 'No, go back to selection', value: 'cancel' },
  ];

  // Get the selected message for display (with bounds checking)
  const selectedMessage =
    selectedMessageIndex !== null && selectedMessageIndex >= 0 && selectedMessageIndex < messages.length
      ? messages[selectedMessageIndex]
      : null;
  const selectedPreview = selectedMessage
    ? selectedMessage.content.length > 50
      ? selectedMessage.content.substring(0, 50) + '...'
      : selectedMessage.content
    : '';

  return (
    <Box flexDirection="column" marginY={1}>
      <Box marginBottom={1} flexDirection="column">
        <Text bold>Confirm rewind operation:</Text>
        <Text dimColor>Message: {selectedPreview}</Text>
        <Text color="yellow">
          This will remove {messagesToRemove.length} message(s) ({tokensToRemove.toLocaleString()} tokens)
        </Text>
        <Text color="cyan">The selected message will be placed in your input for editing.</Text>
      </Box>

      <SelectInput
        items={confirmationItems}
        onSelect={handleConfirmationSelect}
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
        <Text dimColor>Use ↑↓ arrows to navigate, Enter to select, Esc to go back</Text>
      </Box>
    </Box>
  );
}
