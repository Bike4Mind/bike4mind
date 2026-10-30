import { useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { useUser } from '@client/app/contexts/UserContext';
import { useNavigate } from '@tanstack/react-router';
import { useGetSession } from '@client/app/hooks/data/sessions';
import { recordSessionActivity, getSessionActivity } from '@client/app/utils/sessionActivityCleanup';
import { updateUserToServer } from '@client/app/utils/userAPICalls';

export interface SessionResumptionOptions {
  maxIdleMinutes?: number; // Default 60 minutes
  alwaysCreateNew?: boolean; // Override to always create new
}

/**
 * Hook to determine whether to resume last session or create new one
 * @param options Configuration for session resumption behavior
 */
export function useSessionResumption(options: SessionResumptionOptions = {}) {
  const { maxIdleMinutes = 60, alwaysCreateNew = false } = options;
  const { currentUser } = useUser();
  const navigate = useNavigate();
  const [shouldResume, setShouldResume] = useState<boolean | null>(null);
  const [lastSessionId, setLastSessionId] = useState<string | null>(null);

  // Get the last session data if we have an ID
  const { data: lastSession, isLoading, error: lastSessionError } = useGetSession(lastSessionId);
  // A last session that won't open (deleted, or no longer shared) means start fresh. Without this a
  // failed fetch either navigated into the dead session anyway or left the decision pending forever.
  const lastSessionFailed = !!lastSessionError;
  const clearedNotebookIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!currentUser) {
      setShouldResume(false);
      return;
    }

    if (alwaysCreateNew) {
      setShouldResume(false);
      return;
    }

    const lastNotebookId = currentUser.lastNotebookId;
    if (!lastNotebookId) {
      setShouldResume(false);
      return;
    }

    // Check localStorage for last activity timestamp
    const lastActivity = getSessionActivity(lastNotebookId);

    if (!lastActivity) {
      // No activity record, fetch the session to check
      setLastSessionId(lastNotebookId);
      return;
    }

    const lastActivityTime = new Date(lastActivity).getTime();
    const now = new Date().getTime();
    const idleMinutes = (now - lastActivityTime) / (1000 * 60);

    if (idleMinutes < maxIdleMinutes) {
      // Within idle threshold, resume the session
      setShouldResume(true);
      setLastSessionId(lastNotebookId);
    } else {
      // Been idle too long, start fresh
      setShouldResume(false);
      // Old activity records are cleaned up by TTL-based cleanup on app mount
    }
  }, [currentUser, maxIdleMinutes, alwaysCreateNew]);

  // Once we have the session data, make final decision
  useEffect(() => {
    if (lastSession && shouldResume === null) {
      // Check session's last update time as fallback
      const lastUpdate = new Date(lastSession.updatedAt || lastSession.createdAt).getTime();
      const now = new Date().getTime();
      const idleMinutes = (now - lastUpdate) / (1000 * 60);

      setShouldResume(idleMinutes < maxIdleMinutes);
    }
  }, [lastSession, shouldResume, maxIdleMinutes]);

  // A 404 means the pointer itself is dead: clear it so the next sign-in doesn't ask for it again.
  useEffect(() => {
    if (!currentUser || !lastSessionId || clearedNotebookIdRef.current === lastSessionId) return;
    if (!isAxiosError(lastSessionError) || lastSessionError.response?.status !== 404) return;
    if (currentUser.lastNotebookId !== lastSessionId) return;
    clearedNotebookIdRef.current = lastSessionId;
    updateUserToServer(currentUser.id, { lastNotebookId: null }).catch(error => {
      console.warn('[useSessionResumption] Failed to clear a dangling lastNotebookId', error);
    });
  }, [currentUser, lastSessionId, lastSessionError]);

  const resume = !!shouldResume && !lastSessionFailed;

  const navigateToSession = () => {
    if (resume && lastSessionId) {
      navigate({ to: '/notebooks/$id', params: { id: lastSessionId } });
    } else {
      navigate({ to: '/new' });
    }
  };

  const recordActivity = (sessionId: string) => {
    recordSessionActivity(sessionId);
  };

  return {
    shouldResume: lastSessionFailed ? false : shouldResume,
    lastSessionId,
    isLoading: !lastSessionFailed && (isLoading || shouldResume === null),
    navigateToSession,
    recordActivity,
    lastSession,
  };
}
