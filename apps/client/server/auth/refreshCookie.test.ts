import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import {
  ADMIN_RETURN_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  clearSessionCookies,
  readAdminReturnCookie,
  readRefreshCookie,
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
});
