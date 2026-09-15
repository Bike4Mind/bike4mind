import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useEffect } from 'react';
import { isQuotaExceededError, TTL } from '@client/app/utils/localStorageUtils';

const STORAGE_KEY = 'session_last_viewed_timestamps';

/**
 * Get last viewed timestamps from localStorage
 */
function getLastViewedTimestamps(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

/**
 * Clean up entries older than 30 days from the timestamps object
 *
 * @returns Number of entries removed
 */
export function cleanupOldViewedTimestamps(): number {
  if (typeof window === 'undefined') return 0;

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return 0;

    const timestamps: Record<string, string> = JSON.parse(stored);
    const now = Date.now();
    let removedCount = 0;

    const filtered = Object.fromEntries(
      Object.entries(timestamps).filter(([, timestamp]) => {
        const entryTime = new Date(timestamp).getTime();
        const isExpired = isNaN(entryTime) || now - entryTime > TTL.SESSION_VIEWED;
        if (isExpired) removedCount++;
        return !isExpired;
      })
    );

    if (removedCount > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
      console.log(`[ViewedTimestamps] Cleaned up ${removedCount} expired entries`);
    }

    return removedCount;
  } catch {
    return 0;
  }
}

/**
 * Save last viewed timestamps to localStorage with QuotaExceeded handling
 */
function saveLastViewedTimestamps(timestamps: Record<string, string>) {
  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(timestamps));
  } catch (error) {
    if (isQuotaExceededError(error)) {
      cleanupOldViewedTimestamps();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(timestamps));
      } catch {
        console.error('Failed to save last viewed timestamps even after cleanup');
      }
    } else {
      console.error('Failed to save last viewed timestamps:', error);
    }
  }
}

/**
 * Mark a session as viewed (updates timestamp to now)
 */
export function markSessionAsViewed(sessionId: string) {
  const timestamps = getLastViewedTimestamps();
  timestamps[sessionId] = new Date().toISOString();
  saveLastViewedTimestamps(timestamps);
}

/**
 * Hook to get unread proactive message counts for all sessions
 * Fetches sessions with their latest proactive message timestamp from server,
 * then compares with local viewed timestamps to determine unread count
 */
export function useUnreadProactiveMessages() {
  return useQuery({
    queryKey: ['recent-proactive-messages'],
    queryFn: async (): Promise<Record<string, number>> => {
      // Fetch sessions with their latest proactive message timestamps
      const response = await api.get<Record<string, string>>('/api/sessions/recent-proactive-messages');
      const recentProactiveMessages = response.data;

      // Get local viewed timestamps
      const viewedTimestamps = getLastViewedTimestamps();

      // Calculate unread count for each session
      const unreadCounts: Record<string, number> = {};

      Object.entries(recentProactiveMessages).forEach(([sessionId, messageTimestamp]) => {
        const lastViewed = viewedTimestamps[sessionId];

        // If never viewed, or message is newer than last view, it's unread
        if (!lastViewed || new Date(messageTimestamp) > new Date(lastViewed)) {
          unreadCounts[sessionId] = 1; // Latest message is unread
        }
      });

      return unreadCounts;
    },
    staleTime: 5 * 60 * 1000, // Consider data stale after 5 minutes
  });
}

/**
 * Hook to mark session as viewed when user navigates to it
 * Call this from the session/notebook view component
 */
export function useMarkSessionViewed(sessionId: string | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (sessionId) {
      // Mark this session as viewed with current timestamp
      markSessionAsViewed(sessionId);
      // Invalidate the query to recalculate unread counts
      queryClient.invalidateQueries({ queryKey: ['recent-proactive-messages'] });
    }
  }, [sessionId, queryClient]);
}

/**
 * Get unread count for a specific session
 */
export function useSessionUnreadCount(sessionId: string) {
  const { data: unreadCounts } = useUnreadProactiveMessages();
  return unreadCounts?.[sessionId] ?? 0;
}
