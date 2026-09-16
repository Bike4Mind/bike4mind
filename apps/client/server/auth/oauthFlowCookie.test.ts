import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import {
  STATE_NONCE_COOKIE_NAME,
  OKTA_PKCE_COOKIE_NAME,
  issueStateNonce,
  readStateNonceHash,
  stateNonceMatches,
  clearStateNonce,
  setPkceVerifierCookie,
  readPkceVerifierCookie,
} from './oauthFlowCookie';

/** Minimal Set-Cookie-accumulating response stub (mirrors refreshCookie's usage). */
function makeRes() {
  const cookies: string[] = [];
  const res = {
    getHeader: () => (cookies.length ? cookies : undefined),
    setHeader: (_name: string, value: string | string[]) => {
      cookies.length = 0;
      cookies.push(...(Array.isArray(value) ? value : [value]));
    },
  } as unknown as Response;
  return { res, cookies };
}

/** Build a request whose Cookie header carries the value most recently set on `res`. */
function reqWith(cookieHeader: string | undefined) {
  return { headers: { cookie: cookieHeader } } as unknown as Request;
}

/** Extract `name=value` from a Set-Cookie string. */
function cookieValue(setCookie: string, name: string): string | undefined {
  const match = setCookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? match[1] : undefined;
}

describe('oauthFlowCookie', () => {
  it('binds a browser: the hash returned at flow-start matches the cookie read at callback', () => {
    const { res, cookies } = makeRes();
    const returnedHash = issueStateNonce(res);

    const setCookie = cookies.find(c => c.startsWith(`${STATE_NONCE_COOKIE_NAME}=`))!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\/api/);

    const nonce = cookieValue(setCookie, STATE_NONCE_COOKIE_NAME)!;
    const req = reqWith(`${STATE_NONCE_COOKIE_NAME}=${nonce}`);
    expect(readStateNonceHash(req)).toBe(returnedHash);
    expect(stateNonceMatches(req, { nh: returnedHash })).toBe(true);
  });

  it('only the hash travels in the token, never the raw nonce', () => {
    const { res, cookies } = makeRes();
    const returnedHash = issueStateNonce(res);
    const nonce = cookieValue(cookies[0], STATE_NONCE_COOKIE_NAME)!;
    expect(returnedHash).not.toBe(nonce);
    expect(returnedHash).toHaveLength(64); // sha256 hex
  });

  it('fails closed when the browser presents no nonce cookie', () => {
    const req = reqWith(undefined);
    expect(readStateNonceHash(req)).toBeNull();
    expect(stateNonceMatches(req, { nh: 'anything' })).toBe(false);
  });

  it('rejects a nonce from a different browser', () => {
    const { res: resA } = makeRes();
    const hashA = issueStateNonce(resA);
    const { res: resB, cookies: cookiesB } = makeRes();
    issueStateNonce(resB);
    const nonceB = cookieValue(cookiesB[0], STATE_NONCE_COOKIE_NAME)!;

    // Browser B presents its own cookie against a state minted for browser A.
    const reqB = reqWith(`${STATE_NONCE_COOKIE_NAME}=${nonceB}`);
    expect(stateNonceMatches(reqB, { nh: hashA })).toBe(false);
  });

  it('never matches a payload with no nh claim', () => {
    const { res, cookies } = makeRes();
    issueStateNonce(res);
    const nonce = cookieValue(cookies[0], STATE_NONCE_COOKIE_NAME)!;
    const req = reqWith(`${STATE_NONCE_COOKIE_NAME}=${nonce}`);
    expect(stateNonceMatches(req, {})).toBe(false);
    expect(stateNonceMatches(req, { nh: '' })).toBe(false);
  });

  it('clears the nonce cookie with Max-Age=0', () => {
    const { res, cookies } = makeRes();
    clearStateNonce(res);
    expect(cookies[0]).toMatch(new RegExp(`${STATE_NONCE_COOKIE_NAME}=; .*Max-Age=0`));
  });

  it('round-trips the PKCE verifier through an HttpOnly cookie', () => {
    const { res, cookies } = makeRes();
    setPkceVerifierCookie(res, 'the-code-verifier');
    const setCookie = cookies.find(c => c.startsWith(`${OKTA_PKCE_COOKIE_NAME}=`))!;
    expect(setCookie).toMatch(/HttpOnly/);
    const req = reqWith(`${OKTA_PKCE_COOKIE_NAME}=the-code-verifier`);
    expect(readPkceVerifierCookie(req)).toBe('the-code-verifier');
  });
});
