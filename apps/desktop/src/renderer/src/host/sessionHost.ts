import { LOCAL_HOST_ID } from '@shared/hostBridge';
import { sessionDirectory } from './sessionDirectory';

/**
 * The host a session lives on, read from the session directory; with no session, the local host,
 * which is where a new session, model list or project lookup goes unless the caller names another.
 * An id no host has listed yet (a session restored at launch before its list arrives) is taken as
 * local, which is where every session lived before remote hosts.
 */
export function hostForSession(sessionId?: string): string {
  if (!sessionId) return LOCAL_HOST_ID;
  return sessionDirectory.hostOf(sessionId) ?? LOCAL_HOST_ID;
}
