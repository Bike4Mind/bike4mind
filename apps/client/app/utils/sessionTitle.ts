/**
 * Display-time session-title cleanup.
 *
 * Canonical implementation lives in `@bike4mind/common` so the client and the
 * server-side auto-namer (`sanitizeSessionTitle`) can never drift. Re-exported
 * here to preserve the `@client/app/utils/sessionTitle` import path.
 */
export { formatSessionTitle } from '@bike4mind/common';
