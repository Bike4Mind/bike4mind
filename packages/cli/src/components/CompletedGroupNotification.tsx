import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import { useCliStore } from '../store';

/** Time to display notifications before clearing (ms) */
const NOTIFICATION_DISPLAY_DURATION_MS = 3000;

/**
 * Displays notifications when all background agents in a group complete.
 * These notifications are shown above the input prompt and auto-clear after display.
 */
export function CompletedGroupNotification() {
  const notifications = useCliStore(state => state.completedGroupNotifications);
  const clearNotifications = useCliStore(state => state.clearCompletedGroupNotifications);

  // Auto-clear notifications after they've been displayed
  // Use notifications.length as dependency to avoid re-running on every array reference change
  useEffect(() => {
    if (notifications.length > 0) {
      const timer = setTimeout(() => {
        clearNotifications();
      }, NOTIFICATION_DISPLAY_DURATION_MS);
      return () => clearTimeout(timer);
    }
  }, [notifications.length, clearNotifications]);

  if (notifications.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      {notifications.map((item, index) => (
        <Box key={`${item.timestamp}-${index}`} flexDirection="column">
          <Box>
            <Text color="green" bold>
              {'\u2714'}{' '}
            </Text>
            <Text color="green" bold>
              {item.groupDescription
                ? `Background tasks completed: "${item.groupDescription}"`
                : 'Background tasks completed'}
            </Text>
          </Box>
          <Box paddingLeft={2}>
            <Text dimColor italic>
              Results will be incorporated in the next response.
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
