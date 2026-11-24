import { createHash, randomBytes } from 'crypto';
import { authSessionRepository, oauthAuthorizationCodeRepository } from '@bike4mind/database';

/**
 * Single-use codes that let B4M Desktop open the web app already signed in, so its embedded
 * web conversations window never runs the web sign-in (and its Turnstile challenge) itself.
 *
 * The codes live in the OAuth authorization-code store under a client id that is never registered,
 * so /api/oauth/token rejects them at validateClient before it looks a code up. Only a SHA-256 of
 * the code is stored. Minted by pages/api/auth/desktop-web-session/index.ts, redeemed by
 * pages/api/auth/desktop-web-session/redeem.ts; the Desktop caller is apps/desktop/src/main/handoff.
 */
export const DESKTOP_WEB_SESSION_CLIENT_ID = 'b4m-desktop-web-session';
const DESKTOP_WEB_SESSION_REDIRECT_URI = 'urn:b4m:desktop-web-session';
export const DESKTOP_WEB_SESSION_CODE_TTL_SECONDS = 60;

const hashCode = (code: string) => createHash('sha256').update(code).digest('base64url');

/** Mint a code bound to the user and the Desktop session (sid) asking for it. */
export async function mintDesktopWebSessionCode(params: { userId: string; parentSid: string }): Promise<string> {
  const code = randomBytes(32).toString('base64url');
  await oauthAuthorizationCodeRepository.create({
    code: hashCode(code),
    clientId: DESKTOP_WEB_SESSION_CLIENT_ID,
    userId: params.userId,
    redirectUri: DESKTOP_WEB_SESSION_REDIRECT_URI,
    scopes: [],
    // The parent sid rides in `nonce` so redemption can refuse a code whose Desktop session ended.
    nonce: params.parentSid,
    expiresAt: new Date(Date.now() + DESKTOP_WEB_SESSION_CODE_TTL_SECONDS * 1000),
    used: false,
  });
  return code;
}

/**
 * Atomically spend a code. Returns the user it was minted for, or null when the code is unknown,
 * expired, already used, minted for another client, or its Desktop session has since been revoked.
 */
export async function redeemDesktopWebSessionCode(code: string): Promise<{ userId: string } | null> {
  const claimed = await oauthAuthorizationCodeRepository.consumeValidCode(hashCode(code));
  if (!claimed || claimed.clientId !== DESKTOP_WEB_SESSION_CLIENT_ID || !claimed.nonce) return null;
  const live = await authSessionRepository.findLiveSids([claimed.nonce]);
  return live.has(claimed.nonce) ? { userId: claimed.userId } : null;
}
