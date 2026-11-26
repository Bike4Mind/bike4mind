import { LOCAL_HOST_ID } from '@shared/hostBridge';

/**
 * The host a session lives on; with no session, the host a new session, model list or project
 * lookup goes to. Every chat call made through the host protocol resolves its host here, so
 * serving sessions from more than one host changes this function, not its callers.
 */
export function hostForSession(_sessionId?: string): string {
  return LOCAL_HOST_ID;
}
