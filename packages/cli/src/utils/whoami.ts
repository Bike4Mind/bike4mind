import type { AuthTokens } from '../storage/types.js';
import { SIGN_IN_HINT } from '../bootstrap/signedOutLocal.js';

/** What /whoami prints. A signed-out local session says so even when another process has since saved a sign-in. */
export function whoamiReport(
  authTokens: Pick<AuthTokens, 'userId' | 'expiresAt'> | null,
  session: { signedOutLocal: boolean },
  now = new Date()
): string {
  if (session.signedOutLocal) return `This session is local and signed out. ${SIGN_IN_HINT}`;
  if (!authTokens) return 'Not authenticated. Run /login to authenticate.';
  const expires = new Date(authTokens.expiresAt);
  return [
    '\n\u{1f464} Current User:\n',
    `User ID: ${authTokens.userId}`,
    `Status: ${expires <= now ? '⚠️  Token expired' : '✅ Authenticated'}`,
    `Expires: ${expires.toLocaleString()}`,
    '',
  ].join('\n');
}
