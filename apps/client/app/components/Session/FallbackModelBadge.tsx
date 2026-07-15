import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Chip, Tooltip } from '@mui/joy';
import { Warning as WarningIcon } from '@mui/icons-material';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import {
  FallbackInfo,
  StreamedChatCompletionAction,
  LLMStatusUpdateAction,
  IMessageDataToClient,
} from '@bike4mind/common';
import { z } from 'zod';
import { formatFallbackTooltip } from './fallbackProviderLabel';

interface FallbackModelBadgeProps {
  sessionId: string;
  size?: 'sm' | 'md' | 'lg';
}

const isFallbackInfo = (obj: any): obj is FallbackInfo => {
  return (
    obj &&
    typeof obj.sessionId === 'string' &&
    typeof obj.primaryModel === 'string' &&
    typeof obj.primaryModelName === 'string' &&
    typeof obj.fallbackModel === 'string' &&
    typeof obj.fallbackModelName === 'string' &&
    typeof obj.timestamp === 'number'
  );
};

const storageManager = {
  get: (key: string): FallbackInfo | null => {
    try {
      const item = localStorage.getItem(key);
      if (!item) return null;
      const parsed = JSON.parse(item);
      return isFallbackInfo(parsed) ? parsed : null;
    } catch {
      try {
        const item = sessionStorage.getItem(key);
        if (!item) return null;
        const parsed = JSON.parse(item);
        return isFallbackInfo(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
  },
  set: (key: string, value: FallbackInfo): void => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      try {
        sessionStorage.setItem(key, JSON.stringify(value));
      } catch {
        // Silent fail if both storage methods unavailable
      }
    }
  },
  remove: (key: string): void => {
    try {
      localStorage.removeItem(key);
    } catch {}
    try {
      sessionStorage.removeItem(key);
    } catch {}
  },
};

const FallbackModelBadge: React.FC<FallbackModelBadgeProps> = ({ sessionId, size = 'sm' }) => {
  const [fallbackInfo, setFallbackInfo] = useState<FallbackInfo | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const { subscribeToAction } = useWebsocket();

  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const dismissTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const MAX_RETRIES = 3;

  const setFallbackInfoDebounced = useCallback((info: FallbackInfo | null) => {
    if (updateTimeoutRef.current) {
      clearTimeout(updateTimeoutRef.current);
    }
    updateTimeoutRef.current = setTimeout(() => {
      setFallbackInfo(info);
    }, 100);
  }, []);

  const dismissFallback = useCallback(() => {
    setFallbackInfo(null);
    storageManager.remove('lastFallbackInfo');
  }, []);

  const checkForFallbackInfo = useCallback(() => {
    try {
      const info = storageManager.get('lastFallbackInfo');

      if (!info || info.sessionId !== sessionId) {
        setFallbackInfoDebounced(null);
        return;
      }

      const isRecent = Date.now() - info.timestamp < 5 * 60 * 1000;
      setFallbackInfoDebounced(isRecent ? info : null);
      setRetryCount(0); // Reset on success
    } catch (error) {
      if (retryCount < MAX_RETRIES) {
        setTimeout(() => setRetryCount(prev => prev + 1), 1000);
      }
    }
  }, [sessionId, setFallbackInfoDebounced, retryCount, MAX_RETRIES]);

  useEffect(() => {
    checkForFallbackInfo(); // Initial check

    // Listen for storage changes from other tabs
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'lastFallbackInfo') {
        checkForFallbackInfo();
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [checkForFallbackInfo]);

  // Subscribe to streamed_chat_completion messages to check for fallback info
  useEffect(() => {
    const unsubscribe = subscribeToAction('streamed_chat_completion', async (message: IMessageDataToClient) => {
      // Type guard: ensure this is a streamed_chat_completion message with quest data
      if (message.action !== 'streamed_chat_completion' || !('quest' in message)) {
        return;
      }

      const streamedMessage = message as z.infer<typeof StreamedChatCompletionAction>;

      // Check if this message is for our session and has fallback info
      if (streamedMessage.quest?.sessionId === sessionId && streamedMessage.quest?.fallbackInfo) {
        console.log('[FallbackBadge] ✅ Backend Fallback detected!', streamedMessage.quest.fallbackInfo);

        // Validate the fallback info and store it
        if (isFallbackInfo(streamedMessage.quest.fallbackInfo)) {
          storageManager.set('lastFallbackInfo', streamedMessage.quest.fallbackInfo);
          setFallbackInfoDebounced(streamedMessage.quest.fallbackInfo);
        }
      }
    });

    return unsubscribe;
  }, [sessionId, subscribeToAction, setFallbackInfoDebounced]);

  // Subscribe to llm_status_update messages for queue handler fallback notifications
  useEffect(() => {
    const unsubscribe = subscribeToAction('llm_status_update', async (message: IMessageDataToClient) => {
      // Type guard: ensure this is an llm_status_update message
      if (message.action !== 'llm_status_update') {
        return;
      }

      const statusMessage = message as z.infer<typeof LLMStatusUpdateAction>;

      // Check if this is a fallback status update
      if (statusMessage.status?.startsWith('FALLBACK_USED:') && statusMessage.clientId === sessionId) {
        console.log('[FallbackBadge] ✅ Queue Handler Fallback detected!', statusMessage);

        try {
          // Parse the fallback info from the status string
          const fallbackData = JSON.parse(statusMessage.status.replace('FALLBACK_USED:', ''));

          // Validate and store the fallback info
          if (isFallbackInfo(fallbackData)) {
            storageManager.set('lastFallbackInfo', fallbackData);
            setFallbackInfoDebounced(fallbackData);
          } else {
            console.warn('[FallbackBadge] ⚠️ Invalid queue handler fallback data:', fallbackData);
          }
        } catch (error) {
          console.error('[FallbackBadge] ❌ Failed to parse queue handler fallback data:', error);
        }
      }
    });

    return unsubscribe;
  }, [sessionId, subscribeToAction, setFallbackInfoDebounced]);

  // Auto-dismiss after 5 minutes
  useEffect(() => {
    if (!fallbackInfo) return;

    const timeRemaining = 5 * 60 * 1000 - (Date.now() - fallbackInfo.timestamp);
    if (timeRemaining <= 0) {
      dismissFallback();
      return;
    }

    dismissTimeoutRef.current = setTimeout(dismissFallback, timeRemaining);
    return () => {
      if (dismissTimeoutRef.current) {
        clearTimeout(dismissTimeoutRef.current);
      }
    };
  }, [fallbackInfo, dismissFallback]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
      }
      if (dismissTimeoutRef.current) {
        clearTimeout(dismissTimeoutRef.current);
      }
    };
  }, []);

  if (!fallbackInfo) return null;

  // Open downward: the badge lives in the chat-list header at the top of the view, so a
  // top-placed tooltip overflowed into the toolbar chrome above (QA-reported overlap).
  return (
    <Tooltip title={formatFallbackTooltip(fallbackInfo)} placement="bottom">
      <Chip
        variant="soft"
        color="warning"
        size={size}
        startDecorator={<WarningIcon />}
        sx={{
          fontSize: '0.75rem',
          height: '20px',
          '--Chip-paddingInline': '6px',
          '--Chip-gap': '4px',
          ml: 1,
        }}
        onClick={dismissFallback}
      >
        Fallback Model Used
      </Chip>
    </Tooltip>
  );
};

export default FallbackModelBadge;
