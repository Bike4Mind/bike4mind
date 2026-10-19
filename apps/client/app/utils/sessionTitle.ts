/**
 * Display-time session-title cleanup.
 *
 * Canonical implementation lives in `@bike4mind/common` so the client and the
 * server-side auto-namer (`sanitizeSessionTitle`) can never drift. Re-exported
 * here to preserve the `@client/app/utils/sessionTitle` import path.
 */
export { formatSessionTitle } from '@bike4mind/common';

const DEFAULT_SESSION_NAME = 'New Notebook';
export const AUTO_TITLE_PENDING_WINDOW_MS = 2 * 60 * 1000;

/**
 * Returns an in-progress label while a freshly created session still carries the
 * default name (the auto-title has not landed yet), otherwise null. The window keeps
 * a session whose naming failed from showing the placeholder forever.
 */
export function getPendingTitleLabel(
  name: string,
  firstCreated: Date | string | undefined,
  now: number = Date.now()
): string | null {
  if (name !== DEFAULT_SESSION_NAME || !firstCreated) return null;
  const age = now - new Date(firstCreated).getTime();
  return age >= 0 && age < AUTO_TITLE_PENDING_WINDOW_MS ? 'Naming chat...' : null;
}
