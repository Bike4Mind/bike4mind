import { randomBytes, createHash } from 'crypto';
import type { Request, Response } from 'express';
import { appendSetCookie, readCookie, secureAttribute } from './refreshCookie';

/**
 * Browser-binding cookies for OAuth/SSO flows.
 *
 * A flow-start sets a random, HttpOnly nonce cookie and embeds only its SHA-256
 * hash (the `nh` claim) in the signed state token. The callback re-reads the
 * cookie, hashes it, and requires it to match `nh`. A state/authorize URL minted
 * in one browser therefore cannot be completed in another - it never carries that
 * browser's cookie. Because only the hash travels in the token, a captured state
 * param never reveals the cookie value.
 *
 * verifyStateToken enforces the match for callers that pass the cookie hash (the
 * Okta and passport login paths); linking callbacks that hand-roll or inject their
 * own state verification call stateNonceMatches() directly.
 *
 * The PKCE code_verifier rides the same cookie transport (Okta): it is a
 * per-browser secret that must never travel in the URL/state, so a browser-bound
 * HttpOnly cookie is its correct home.
 */

// SameSite=Lax, not Strict: the IdP returns the browser to our callback via a
// top-level cross-site GET navigation, which Strict would strip the cookie from,
// breaking every login. Lax still sends the cookie on a top-level GET navigation.
// Path=/api so a single cookie covers every callback path (all live under /api).
export const STATE_NONCE_COOKIE_NAME = 'b4m_oauth_nonce';
export const OKTA_PKCE_COOKIE_NAME = 'b4m_okta_pkce';

// Per-flow nonce slots. A signed-in user can have several *link* flows open at
// once (Drive connect, Slack user-link, org Slack-connect); giving each its own
// cookie slot means starting or completing one never overwrites, nor burns, a
// sibling flow's still-pending nonce. Callers that omit a slot (login / SSO / MCP)
// keep sharing the single base cookie, exactly as before.
export const NONCE_SLOT = {
  driveConnect: 'google-drive',
  slackUserLink: 'slack-user-link',
  orgSlackConnect: 'org-slack-connect',
} as const;

// A slot suffixes the base cookie name; no slot keeps the base cookie unchanged.
const nonceCookieName = (slot?: string): string =>
  slot ? `${STATE_NONCE_COOKIE_NAME}_${slot}` : STATE_NONCE_COOKIE_NAME;
const FLOW_COOKIE_PATH = '/api';

// 10 minutes: covers a slow IdP round-trip with room to spare (matches the
// existing gh_oauth_uid binding cookie) while keeping a stale nonce short-lived.
const FLOW_COOKIE_TTL_SECONDS = 600;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function setFlowCookie(res: Response, name: string, value: string): void {
  appendSetCookie(
    res,
    `${name}=${value}; Path=${FLOW_COOKIE_PATH}; Max-Age=${FLOW_COOKIE_TTL_SECONDS}; HttpOnly; SameSite=Lax${secureAttribute()}`
  );
}

function expireFlowCookie(res: Response, name: string): void {
  appendSetCookie(res, `${name}=; Path=${FLOW_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${secureAttribute()}`);
}

/**
 * Sets the browser-binding nonce cookie and returns the hash to embed as the state
 * token's `nh` claim. Call once at flow-start (before minting the state token).
 * Pass a NONCE_SLOT to use a per-flow cookie so concurrent link flows do not evict
 * each other; the matching readStateNonceHash/clearStateNonce must pass the same slot.
 */
export function issueStateNonce(res: Response, slot?: string): string {
  const nonce = randomBytes(32).toString('hex');
  setFlowCookie(res, nonceCookieName(slot), nonce);
  return sha256(nonce);
}

/** Hash of the nonce cookie on this request, or null if the cookie is absent. */
export function readStateNonceHash(req: Pick<Request, 'headers'>, slot?: string): string | null {
  const nonce = readCookie(req, nonceCookieName(slot));
  return nonce ? sha256(nonce) : null;
}

/**
 * True when the state payload's `nh` claim matches this browser's nonce cookie.
 * Fails closed: a payload with no `nh`, or a request with no cookie, never matches.
 * For linking callbacks whose state verification does not route through
 * verifyStateToken's own nonce check.
 */
export function stateNonceMatches(req: Pick<Request, 'headers'>, payload: { nh?: unknown }): boolean {
  const expected = readStateNonceHash(req);
  return typeof payload.nh === 'string' && payload.nh.length > 0 && payload.nh === expected;
}

/** Expire the nonce cookie once a flow completes (success or terminal failure). */
export function clearStateNonce(res: Response, slot?: string): void {
  expireFlowCookie(res, nonceCookieName(slot));
}

/** Store the PKCE code_verifier (Okta) in a browser-bound HttpOnly cookie at flow-start. */
export function setPkceVerifierCookie(res: Response, verifier: string): void {
  setFlowCookie(res, OKTA_PKCE_COOKIE_NAME, verifier);
}

/** Read the PKCE code_verifier back at the callback. */
export function readPkceVerifierCookie(req: Pick<Request, 'headers'>): string | null {
  return readCookie(req, OKTA_PKCE_COOKIE_NAME);
}

/** Expire the PKCE cookie once the code exchange is done. */
export function clearPkceVerifierCookie(res: Response): void {
  expireFlowCookie(res, OKTA_PKCE_COOKIE_NAME);
}
