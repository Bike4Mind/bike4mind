import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import type { Session } from '../storage/types';

interface SessionSelectorProps {
  sessions: Session[];
  currentSession: Session | null;
  onSelect: (session: Session) => void;
  onCancel: () => void;
}

type SessionItem = {
  key?: string;
  label: string;
  value: Session;
};

type ConfirmationItem = {
  key?: string;
  label: string;
  value: 'confirm' | 'cancel';
};

type Step = 'selection' | 'confirmation';

export function SessionSelector({ sessions, currentSession, onSelect, onCancel }: SessionSelectorProps) {
  const [step, setStep] = useState<Step>('selection');
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);

  // Handle Escape key for navigation
  useInput((_input, key) => {
    if (key.escape) {
      if (step === 'confirmation') {
        // In confirmation step: go back to selection
        setStep('selection');
        setSelectedSession(null);
      } else {
        // In selection step: cancel operation
        onCancel();
      }
    }
  });

  // Check for unsaved work in current session
  const hasUnsavedWork = currentSession && currentSession.messages.length > 0;

  // Helper to format time ago
  const formatTimeAgo = (timestamp: string): string => {
    const now = new Date();
    const then = new Date(timestamp);
    const diffMs = now.getTime() - then.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) {
      return `${diffMins}m`;
    } else if (diffHours < 24) {
      return `${diffHours}h`;
    } else {
      return `${diffDays}d`;
    }
  };

  // Create selection items (sessions are already sorted by most recent from SessionStore)
  const items: SessionItem[] = sessions.map((session, index) => {
    // Find the most recent user message
    const userMessages = session.messages.filter(msg => msg.role === 'user');
    const lastUserMessage = userMessages[userMessages.length - 1];
    const preview = lastUserMessage
      ? lastUserMessage.content.slice(0, 50).replace(/\n/g, ' ') + (lastUserMessage.content.length > 50 ? '...' : '')
      : 'No messages';

    const timeAgo = formatTimeAgo(session.updatedAt);

    return {
      key: session.id,
      label: `[${index + 1}] ${preview} (${timeAgo})`,
      value: session,
    };
  });

  const handleSelectionSelect = (item: SessionItem) => {
    setSelectedSession(item.value);
    setStep('confirmation');
  };

  const handleConfirmationSelect = (item: ConfirmationItem) => {
    if (item.value === 'confirm' && selectedSession) {
      onSelect(selectedSession);
    } else {
      // Go back to selection and reset selected session
      setStep('selection');
      setSelectedSession(null);
    }
  };

  if (step === 'selection') {
    return (
      <Box flexDirection="column" marginY={1}>
        <Box marginBottom={1}>
          <Text bold>Select a session to resume:</Text>
        </Box>

        <SelectInput
          items={items}
          onSelect={handleSelectionSelect}
          itemComponent={({ isSelected, label }) => (
            <Box>
              <Text color={isSelected ? 'cyan' : undefined}>{label}</Text>
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
    { label: 'Yes, resume this session', value: 'confirm' },
    { label: 'No, go back to selection', value: 'cancel' },
  ];

  return (
    <Box flexDirection="column" marginY={1}>
      <Box marginBottom={1} flexDirection="column">
        <Text bold>Resume session: &quot;{selectedSession?.name}&quot;</Text>
        <Text dimColor>
          {selectedSession?.messages.length} messages | {selectedSession?.model} |{' '}
          {selectedSession?.metadata?.totalTokens?.toLocaleString() ?? 0} tokens
        </Text>
        {hasUnsavedWork && (
          <Text color="yellow">Warning: Your current session has unsaved messages. Use /save first if needed.</Text>
        )}
      </Box>

      <SelectInput
        items={confirmationItems}
        onSelect={handleConfirmationSelect}
        itemComponent={({ isSelected, label }) => (
          <Box>
            <Text color={isSelected ? 'cyan' : undefined}>{label}</Text>
          </Box>
        )}
      />

      <Box marginTop={1}>
        <Text dimColor>Use ↑↓ arrows to navigate, Enter to select, Esc to go back</Text>
      </Box>
    </Box>
  );
}
