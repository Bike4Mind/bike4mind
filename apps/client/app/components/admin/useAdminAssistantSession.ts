import { useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { ADMIN_ASSISTANT_SURFACE } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

const ADMIN_SESSION_KEY = 'admin-assistant-session-id';

function isGone(err: unknown): boolean {
  if (!isAxiosError(err)) return false;
  const status = err.response?.status;
  return status === 404 || status === 403;
}

async function findSavedSession(): Promise<string | null> {
  const savedId = localStorage.getItem(ADMIN_SESSION_KEY);
  if (!savedId) return null;
  try {
    const { data } = await api.get<{ surface?: string }>(`/api/sessions/${savedId}`);
    // Sessions saved before the admin assistant existed carry no surface, so they get none of its tools.
    if (data?.surface === ADMIN_ASSISTANT_SURFACE) return savedId;
  } catch (err) {
    // Only a missing or forbidden session is replaced; a transient failure keeps the saved one.
    if (!isGone(err)) {
      console.warn('Could not verify the saved Admin Assistant session, reusing it:', err);
      return savedId;
    }
  }
  localStorage.removeItem(ADMIN_SESSION_KEY);
  return null;
}

/** The id of the admin-assistant chat session, reused across visits and created on first use. */
export function useAdminAssistantSession(enabled: boolean): string | null {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current || !enabled) return;
    initialized.current = true;

    (async () => {
      const savedId = await findSavedSession();
      if (savedId) {
        setSessionId(savedId);
        return;
      }
      try {
        const { data } = await api.post<{ id: string }>('/api/sessions/create', {
          name: 'Admin Assistant',
          surface: ADMIN_ASSISTANT_SURFACE,
        });
        localStorage.setItem(ADMIN_SESSION_KEY, data.id);
        setSessionId(data.id);
      } catch (err) {
        console.error('Failed to create Admin Assistant session:', err);
      }
    })();
  }, [enabled]);

  return sessionId;
}
