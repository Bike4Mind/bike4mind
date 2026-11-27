import { useSyncExternalStore } from 'react';
import { LOCAL_HOST_ID } from '@shared/hostBridge';
import { sessionDirectory, type SessionDirectory } from './sessionDirectory';

/**
 * The host a session lives on, read from the session directory; with no session, the local host,
 * which is where a new session, model list or project lookup goes unless the caller names another.
 * An id no host has listed or been expected on yet is taken as local, which is where every session
 * lived before remote hosts; one remembered from an earlier run is expected on its last host (see
 * sessionHostMemory).
 */
export function hostForSession(sessionId?: string, directory: SessionDirectory = sessionDirectory): string {
  if (!sessionId) return LOCAL_HOST_ID;
  return directory.hostOf(sessionId) ?? LOCAL_HOST_ID;
}

/** hostForSession, re-rendering when the directory learns or loses the session's host. */
export function useSessionHost(
  sessionId: string | null | undefined,
  directory: SessionDirectory = sessionDirectory
): string {
  const read = () => hostForSession(sessionId ?? undefined, directory);
  return useSyncExternalStore(directory.subscribe, read, read);
}
