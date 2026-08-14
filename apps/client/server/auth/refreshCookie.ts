import type { Request, Response } from 'express';

/**
 * Refresh-token cookie transport.
 *
 * Browser sessions carry the opaque `<sid>.<secret>` refresh token in an HttpOnly cookie
 * instead of localStorage: script-writable storage is capped at ~7 days by WebKit ITP (so
 * mobile Safari users were being silently logged out), and a long-lived credential sitting
 * in localStorage is directly exfiltratable by any XSS. The access token stays in JS memory
 * (useAccessToken) because the WebSocket is on a different registrable domain and
 * authenticates with `?token=<accessToken>` - a cookie can't reach it.
 *
 * Non-browser callers (CLI, OAuth authorization-code + device flows) keep passing the refresh
 * token in the request body and receive no cookie - they have no cookie jar. The refresh
 * endpoint accepts either transport; see pages/api/auth/refreshToken.ts.
 */

/** Primary session refresh cookie. */
export const REFRESH_COOKIE_NAME = 'b4m_rt';

/**
 * Parks the impersonating admin's refresh token for the duration of a loginAs, so
 * "Return to safety" can restore the admin session. There is only one primary cookie slot per
 * origin and it is handed to the impersonated user, so the admin's half needs its own name.
 * Replaces the old client-side returnToken/returnRefreshToken pair, which kept the admin's
 * credentials in localStorage - exactly what this change removes.
 */
export const ADMIN_RETURN_COOKIE_NAME = 'b4m_rt_admin';

/**
 * Scoped to /api: the cookie only ever needs to reach the refresh, logout and impersonation
 * endpoints, and this keeps it off every static-asset request. SameSite=Strict is affordable
 * because normal API calls authenticate with `Authorization: Bearer`, so no cross-site
 * navigation depends on the cookie riding along.
 */
const COOKIE_PATH = '/api';

/**
 * Bounds a mobile session, so it tracks the AuthSession lifetime (30d), not the access-token TTL.
 * MUST STAY IN SYNC with DEFAULT_REFRESH_TTL_MS in
 * b4m-core/services/src/authSessionService/constants.ts. Duplicated rather than imported so this
 * transport helper - reached from nearly every auth route - does not drag the services barrel in
 * behind it. A cookie that outlives the session just yields one rejected refresh; one that dies
 * early logs the user out, which is the failure this whole change exists to prevent, so err long.
 */
const REFRESH_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Secure breaks plain-http localhost, where e2e and local dev run. */
const secureAttribute = (): string => (process.env.NODE_ENV === 'production' ? '; Secure' : '');

/**
 * Append rather than overwrite: `res.setHeader('Set-Cookie', string)` replaces any Set-Cookie
 * already on the response (Node treats a string value as the whole header). loginAs sets two
 * cookies in one response, so this must accumulate.
 */
function appendSetCookie(res: Response, cookie: string): void {
  const existing = res.getHeader('Set-Cookie');
  const next = existing
    ? Array.isArray(existing)
      ? [...existing.map(String), cookie]
      : [String(existing), cookie]
    : cookie;
  res.setHeader('Set-Cookie', next);
}

function setCookie(res: Response, name: string, value: string): void {
  appendSetCookie(
    res,
    `${name}=${value}; Path=${COOKIE_PATH}; Max-Age=${REFRESH_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Strict${secureAttribute()}`
  );
}

function expireCookie(res: Response, name: string): void {
  appendSetCookie(res, `${name}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict${secureAttribute()}`);
}

/** Minimal cookie-header parser (same pattern as publishGateToken / analyticsMiddleware). */
export function readCookie(req: Pick<Request, 'headers'>, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

export const setRefreshCookie = (res: Response, token: string): void => setCookie(res, REFRESH_COOKIE_NAME, token);
export const clearRefreshCookie = (res: Response): void => expireCookie(res, REFRESH_COOKIE_NAME);
export const readRefreshCookie = (req: Pick<Request, 'headers'>): string | null => readCookie(req, REFRESH_COOKIE_NAME);

export const setAdminReturnCookie = (res: Response, token: string): void =>
  setCookie(res, ADMIN_RETURN_COOKIE_NAME, token);
export const clearAdminReturnCookie = (res: Response): void => expireCookie(res, ADMIN_RETURN_COOKIE_NAME);
export const readAdminReturnCookie = (req: Pick<Request, 'headers'>): string | null =>
  readCookie(req, ADMIN_RETURN_COOKIE_NAME);

/** Clear every session cookie - logout, and any path that tears a session down. */
export function clearSessionCookies(res: Response): void {
  clearRefreshCookie(res);
  clearAdminReturnCookie(res);
}
