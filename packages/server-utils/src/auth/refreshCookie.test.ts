import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import {
  ADMIN_RETURN_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  clearSessionCookies,
  readAdminReturnCookie,
  readRefreshCookie,
  sessionCookieName,
  setAdminReturnCookie,
  setRefreshCookie,
} from './refreshCookie';

/** Minimal stand-in for the Node response header store the helpers get/append/set through. */
function makeRes() {
  const headers = new Map<string, string | string[]>();
  return {
    getHeader: (name: string) => headers.get(name),
    setHeader: (name: string, value: string | string[]) => headers.set(name, value),
    cookies: () => {
      const raw = headers.get('Set-Cookie');
      return raw === undefined ? [] : Array.isArray(raw) ? raw.map(String) : [String(raw)];
    },
  };
}

const asRes = (r: ReturnType<typeof makeRes>) => r as unknown as Response;
const reqWithCookies = (cookie: string) => ({ headers: { cookie } }) as unknown as Request;
const PREFIXED_REFRESH = `__Host-${REFRESH_COOKIE_NAME}`;
const PREFIXED_ADMIN = `__Host-${ADMIN_RETURN_COOKIE_NAME}`;

describe('refreshCookie', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  describe('setRefreshCookie', () => {
    let res: ReturnType<typeof makeRes>;
    beforeEach(() => {
      res = makeRes();
    });

    it('sets an HttpOnly, SameSite=Strict cookie scoped to /api', () => {
      setRefreshCookie(asRes(res), 'sid.secret');

      const [cookie] = res.cookies();
      expect(cookie).toContain(`${REFRESH_COOKIE_NAME}=sid.secret`);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/api');
    });

    it('outlives the 7-day WebKit ITP storage cap this whole design exists to survive', () => {
      setRefreshCookie(asRes(res), 'sid.secret');

      const maxAge = Number(/Max-Age=(\d+)/.exec(res.cookies()[0])?.[1]);
      expect(maxAge).toBeGreaterThan(7 * 24 * 60 * 60);
    });

    it('marks the cookie Secure in production but not in dev/e2e (plain http)', () => {
      process.env.NODE_ENV = 'production';
      const prod = makeRes();
      setRefreshCookie(asRes(prod), 'sid.secret');
      expect(prod.cookies()[0]).toContain('; Secure');

      process.env.NODE_ENV = 'development';
      const dev = makeRes();
      setRefreshCookie(asRes(dev), 'sid.secret');
      expect(dev.cookies()[0]).not.toContain('Secure');
    });

    it('appends rather than replacing an existing Set-Cookie (loginAs sets two in one response)', () => {
      setRefreshCookie(asRes(res), 'impersonated');
      setAdminReturnCookie(asRes(res), 'admin');

      const cookies = res.cookies();
      expect(cookies).toHaveLength(2);
      expect(cookies[0]).toContain(`${REFRESH_COOKIE_NAME}=impersonated`);
      expect(cookies[1]).toContain(`${ADMIN_RETURN_COOKIE_NAME}=admin`);
    });
  });

  describe('clearSessionCookies', () => {
    it('expires BOTH the session and the impersonation return cookie', () => {
      // An admin logging out mid-impersonation must not keep a live path back into their session.
      const res = makeRes();
      clearSessionCookies(asRes(res));

      const cookies = res.cookies();
      expect(cookies).toHaveLength(2);
      expect(cookies.every(c => c.includes('Max-Age=0'))).toBe(true);
      expect(cookies.some(c => c.startsWith(`${REFRESH_COOKIE_NAME}=;`))).toBe(true);
      expect(cookies.some(c => c.startsWith(`${ADMIN_RETURN_COOKIE_NAME}=;`))).toBe(true);
    });
  });

  describe('reading cookies back', () => {
    it('picks the right cookie out of a multi-cookie header', () => {
      const req = reqWithCookies(`other=x; ${REFRESH_COOKIE_NAME}=sid.secret; ${ADMIN_RETURN_COOKIE_NAME}=admin.sec`);
      expect(readRefreshCookie(req)).toBe('sid.secret');
      expect(readAdminReturnCookie(req)).toBe('admin.sec');
    });

    it('does not match on a name prefix', () => {
      // b4m_rt_admin must never be read as b4m_rt - that would hand a caller the wrong identity.
      expect(readRefreshCookie(reqWithCookies(`${ADMIN_RETURN_COOKIE_NAME}=admin.sec`))).toBeNull();
    });

    it('treats a cleared (empty-valued) cookie as absent', () => {
      expect(readRefreshCookie(reqWithCookies(`${REFRESH_COOKIE_NAME}=`))).toBeNull();
    });

    it('returns null when no cookie header is present at all', () => {
      expect(readRefreshCookie({ headers: {} } as unknown as Request)).toBeNull();
    });
  });

  describe('host-only prefixed name over https', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('names the cookie with the __Host- prefix only when Secure is set', () => {
      expect(sessionCookieName(REFRESH_COOKIE_NAME)).toBe(PREFIXED_REFRESH);
      process.env.NODE_ENV = 'development';
      expect(sessionCookieName(REFRESH_COOKIE_NAME)).toBe(REFRESH_COOKIE_NAME);
    });

    it('writes the prefixed cookie on Path=/ with Secure and no Domain, and expires the bare-name cookie', () => {
      const res = makeRes();
      setRefreshCookie(asRes(res), 'sid.secret');

      const [cookie, legacy] = res.cookies();
      expect(cookie.startsWith(`${PREFIXED_REFRESH}=sid.secret;`)).toBe(true);
      expect(cookie).toContain('; Path=/;');
      expect(cookie).toContain('; Secure');
      expect(cookie).not.toMatch(/Domain=/i);
      expect(legacy.startsWith(`${REFRESH_COOKIE_NAME}=;`)).toBe(true);
      expect(legacy).toContain('Path=/api;');
      expect(legacy).toContain('Max-Age=0');
    });

    it('clears both the prefixed and bare-name copies of every session cookie on logout', () => {
      const res = makeRes();
      clearSessionCookies(asRes(res));

      const cleared = res.cookies().map(c => c.slice(0, c.indexOf('=')));
      expect(cleared.sort()).toEqual(
        [PREFIXED_REFRESH, REFRESH_COOKIE_NAME, PREFIXED_ADMIN, ADMIN_RETURN_COOKIE_NAME].sort()
      );
      expect(res.cookies().every(c => c.includes('Max-Age=0'))).toBe(true);
    });

    it('prefers the prefixed cookie over a bare-name one with a different value', () => {
      const req = reqWithCookies(`${REFRESH_COOKIE_NAME}=other.value; ${PREFIXED_REFRESH}=sid.secret`);
      expect(readRefreshCookie(req)).toBe('sid.secret');
    });

    it('never falls back to the bare name', () => {
      expect(readRefreshCookie(reqWithCookies(`${REFRESH_COOKIE_NAME}=sid.secret`))).toBeNull();
      expect(readAdminReturnCookie(reqWithCookies(`${ADMIN_RETURN_COOKIE_NAME}=admin.sec`))).toBeNull();
    });

    it('treats an empty prefixed cookie as absent rather than falling back to the bare name', () => {
      expect(readRefreshCookie(reqWithCookies(`${PREFIXED_REFRESH}=; ${REFRESH_COOKIE_NAME}=sid.secret`))).toBeNull();
    });

    it('reads the prefixed admin return cookie without confusing it with the refresh cookie', () => {
      const req = reqWithCookies(`${PREFIXED_ADMIN}=admin.sec`);
      expect(readAdminReturnCookie(req)).toBe('admin.sec');
      expect(readRefreshCookie(req)).toBeNull();
    });
  });

  describe('bare name over plain http', () => {
    it('keeps the bare name on /api and writes a single cookie', () => {
      process.env.NODE_ENV = 'development';
      const res = makeRes();
      setRefreshCookie(asRes(res), 'sid.secret');

      expect(res.cookies()).toHaveLength(1);
      expect(res.cookies()[0].startsWith(`${REFRESH_COOKIE_NAME}=sid.secret; Path=/api;`)).toBe(true);
      expect(readRefreshCookie(reqWithCookies(`${PREFIXED_REFRESH}=x.y`))).toBeNull();
    });
  });
});
