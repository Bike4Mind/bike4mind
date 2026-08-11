import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { csrfProtection } from './csrfProtection';
import { ForbiddenError } from '../utils/errors';
import type { Request, Response, NextFunction } from 'express';

const makeReq = (overrides: Partial<{ method: string; headers: Record<string, string> }> = {}): Request =>
  ({
    method: 'POST',
    headers: {},
    ...overrides,
  }) as unknown as Request;

const makeRes = (): Response => ({}) as unknown as Response;
const makeNext = (): NextFunction => vi.fn() as unknown as NextFunction;

describe('csrfProtection', () => {
  const originalAppUrl = process.env.APP_URL;

  beforeEach(() => {
    process.env.APP_URL = 'https://app.bike4mind.com';
  });

  afterEach(() => {
    process.env.APP_URL = originalAppUrl;
  });

  describe('safe methods', () => {
    it.each(['GET', 'HEAD', 'OPTIONS'])('calls next() for %s', method => {
      const next = makeNext();
      csrfProtection()(makeReq({ method }), makeRes(), next);
      expect(next).toHaveBeenCalledOnce();
    });
  });

  describe('API key exemption', () => {
    // The exemption uses extractApiKeyFromHeaders (same extractor as apiKeyAuth), so
    // EVERY accepted form is exempt - not just x-api-key. Reverting the broadening
    // (P3-4) makes the ApiKey / Bearer-b4m_ cases below fail.
    const apiKeyForms: [string, Record<string, string>][] = [
      ['x-api-key', { 'x-api-key': 'b4m_live_somekey' }],
      ['Authorization: ApiKey', { authorization: 'ApiKey b4m_live_somekey' }],
      ['Authorization: Bearer b4m_ (canonical, spec-advertised)', { authorization: 'Bearer b4m_live_somekey' }],
    ];

    it.each(apiKeyForms)('calls next() for an API-key request via %s', (_label, headers) => {
      const next = makeNext();
      csrfProtection()(makeReq({ headers }), makeRes(), next);
      expect(next).toHaveBeenCalledOnce();
    });

    it.each(apiKeyForms)(
      'exempts %s even with a cross-site Sec-Fetch-Site (never reaches origin check)',
      (_l, headers) => {
        const next = makeNext();
        csrfProtection()(makeReq({ headers: { ...headers, 'sec-fetch-site': 'cross-site' } }), makeRes(), next);
        expect(next).toHaveBeenCalledOnce();
      }
    );

    it('does NOT exempt a Bearer JWT (no b4m_ prefix) - it still gets the origin checks', () => {
      expect(() =>
        csrfProtection()(
          makeReq({ headers: { authorization: 'Bearer eyJ.jwt.token', 'sec-fetch-site': 'cross-site' } }),
          makeRes(),
          makeNext()
        )
      ).toThrow(ForbiddenError);
    });
  });

  describe('Sec-Fetch-Site check', () => {
    it('throws ForbiddenError for sec-fetch-site: cross-site without API key', () => {
      expect(() =>
        csrfProtection()(makeReq({ headers: { 'sec-fetch-site': 'cross-site' } }), makeRes(), makeNext())
      ).toThrow(ForbiddenError);
    });

    it('passes through for sec-fetch-site: same-origin', () => {
      const next = makeNext();
      csrfProtection()(
        makeReq({ headers: { 'sec-fetch-site': 'same-origin', origin: 'https://app.bike4mind.com' } }),
        makeRes(),
        next
      );
      expect(next).toHaveBeenCalledOnce();
    });
  });

  describe('Sec-Fetch-Mode check', () => {
    it('throws ForbiddenError for sec-fetch-mode: no-cors', () => {
      expect(() =>
        csrfProtection()(
          makeReq({ headers: { 'sec-fetch-mode': 'no-cors', origin: 'https://app.bike4mind.com' } }),
          makeRes(),
          makeNext()
        )
      ).toThrow(ForbiddenError);
    });

    it.each(['cors', 'same-origin', 'navigate'])('passes through for sec-fetch-mode: %s', mode => {
      const next = makeNext();
      csrfProtection()(
        makeReq({ headers: { 'sec-fetch-mode': mode, origin: 'https://app.bike4mind.com' } }),
        makeRes(),
        next
      );
      expect(next).toHaveBeenCalledOnce();
    });
  });

  describe('Sec-Fetch-Dest check', () => {
    it.each(['image', 'script', 'style', 'audio', 'video', 'font', 'object', 'embed', 'iframe'])(
      'throws ForbiddenError for sec-fetch-dest: %s',
      dest => {
        expect(() =>
          csrfProtection()(
            makeReq({ headers: { 'sec-fetch-dest': dest, origin: 'https://app.bike4mind.com' } }),
            makeRes(),
            makeNext()
          )
        ).toThrow(ForbiddenError);
      }
    );

    it.each(['empty', 'document'])('passes through for sec-fetch-dest: %s', dest => {
      const next = makeNext();
      csrfProtection()(
        makeReq({ headers: { 'sec-fetch-dest': dest, origin: 'https://app.bike4mind.com' } }),
        makeRes(),
        next
      );
      expect(next).toHaveBeenCalledOnce();
    });

    it('rejects unknown sec-fetch-dest values (allowlist semantics)', () => {
      expect(() =>
        csrfProtection()(
          makeReq({ headers: { 'sec-fetch-dest': 'future-spec-value', origin: 'https://app.bike4mind.com' } }),
          makeRes(),
          makeNext()
        )
      ).toThrow(ForbiddenError);
    });
  });

  describe('origin / referer validation', () => {
    it('calls next() when Origin matches APP_URL', () => {
      const next = makeNext();
      csrfProtection()(makeReq({ headers: { origin: 'https://app.bike4mind.com' } }), makeRes(), next);
      expect(next).toHaveBeenCalledOnce();
    });

    it('calls next() when Referer matches APP_URL', () => {
      const next = makeNext();
      csrfProtection()(makeReq({ headers: { referer: 'https://app.bike4mind.com/profile' } }), makeRes(), next);
      expect(next).toHaveBeenCalledOnce();
    });

    it('throws ForbiddenError when Origin is a different domain', () => {
      expect(() =>
        csrfProtection()(makeReq({ headers: { origin: 'https://attacker.com' } }), makeRes(), makeNext())
      ).toThrow(ForbiddenError);
    });

    it('throws ForbiddenError when neither Origin nor Referer is present', () => {
      expect(() => csrfProtection()(makeReq(), makeRes(), makeNext())).toThrow(ForbiddenError);
    });

    it('throws ForbiddenError for subdomain bypass attempt', () => {
      expect(() =>
        csrfProtection()(
          makeReq({ headers: { origin: 'https://app.bike4mind.com.attacker.com' } }),
          makeRes(),
          makeNext()
        )
      ).toThrow(ForbiddenError);
    });
  });

  describe('APP_URL misconfiguration', () => {
    it('throws ForbiddenError when APP_URL is not set', () => {
      delete process.env.APP_URL;
      expect(() =>
        csrfProtection()(makeReq({ headers: { origin: 'https://app.bike4mind.com' } }), makeRes(), makeNext())
      ).toThrow(ForbiddenError);
    });

    it('throws ForbiddenError naming APP_URL when it is not a valid absolute URL', () => {
      process.env.APP_URL = 'app.bike4mind.com';
      expect(() =>
        csrfProtection()(makeReq({ headers: { origin: 'https://app.bike4mind.com' } }), makeRes(), makeNext())
      ).toThrow(/APP_URL is not a valid absolute URL/);
    });

    it('throws ForbiddenError when APP_URL has no usable origin', () => {
      // `new URL()` accepts this; its origin serializes to the string "null", which
      // would otherwise sit in the allow-list matching nothing.
      process.env.APP_URL = 'file:///srv/app';
      expect(() =>
        csrfProtection()(makeReq({ headers: { origin: 'https://app.bike4mind.com' } }), makeRes(), makeNext())
      ).toThrow(/does not resolve to a usable origin/);
    });
  });

  describe('APP_URL normalization', () => {
    // The comparison tests against `new URL(header).origin`, which is always normalized.
    // Pushing the raw env value made the allow-list sensitive to how APP_URL happened to
    // be written, and a mismatch rejected EVERY state-changing request on the deployment
    // while leaving reads working. Each case below fails if the normalization is removed.
    it.each([
      ['a trailing slash', 'https://app.bike4mind.com/'],
      ['a path suffix', 'https://app.bike4mind.com/app'],
      ['an uppercased host', 'https://APP.BIKE4MIND.COM'],
      ['a default port stated explicitly', 'https://app.bike4mind.com:443'],
    ])('accepts a matching Origin when APP_URL is written with %s', (_label, appUrl) => {
      process.env.APP_URL = appUrl;
      const next = makeNext();
      csrfProtection()(makeReq({ headers: { origin: 'https://app.bike4mind.com' } }), makeRes(), next);
      expect(next).toHaveBeenCalledOnce();
    });

    it('still rejects a genuinely different origin when APP_URL has a trailing slash', () => {
      // Normalizing must not widen the allow-list - only make it match what it meant.
      process.env.APP_URL = 'https://app.bike4mind.com/';
      expect(() =>
        csrfProtection()(makeReq({ headers: { origin: 'https://attacker.com' } }), makeRes(), makeNext())
      ).toThrow(ForbiddenError);
    });

    it('still rejects a subdomain bypass attempt when APP_URL has a trailing slash', () => {
      process.env.APP_URL = 'https://app.bike4mind.com/';
      expect(() =>
        csrfProtection()(
          makeReq({ headers: { origin: 'https://app.bike4mind.com.attacker.com' } }),
          makeRes(),
          makeNext()
        )
      ).toThrow(ForbiddenError);
    });

    it('names the expected origin when rejecting, so a misconfigured APP_URL is legible', () => {
      // Without this the message describes only the caller, and a deployment pointing at
      // an origin users never arrive from reads as an attack rather than a config error.
      expect(() =>
        csrfProtection()(makeReq({ headers: { origin: 'https://attacker.com' } }), makeRes(), makeNext())
      ).toThrow(/expected https:\/\/app\.bike4mind\.com/);
    });

    it('does not open the localhost allowance for a non-localhost APP_URL that merely contains the word', () => {
      // The dev branch used a substring test on the raw env value, so any APP_URL
      // CONTAINING "localhost" - in a path, or as part of a longer hostname - switched on
      // the dev allowance and let arbitrary localhost origins through on a deployment that
      // is not localhost. Matching on the normalized hostname makes it exact.
      process.env.APP_URL = 'https://app.bike4mind.com/localhost';
      expect(() =>
        csrfProtection()(makeReq({ headers: { origin: 'http://localhost:5173' } }), makeRes(), makeNext())
      ).toThrow(ForbiddenError);
    });

    it('does not open the localhost allowance for a hostname that only starts with localhost', () => {
      process.env.APP_URL = 'https://localhost.bike4mind.com';
      expect(() =>
        csrfProtection()(makeReq({ headers: { origin: 'http://localhost:5173' } }), makeRes(), makeNext())
      ).toThrow(ForbiddenError);
    });

    it('keeps the localhost allowance working when APP_URL has a trailing slash', () => {
      // The dev branch used to re-read the raw env value, so it could disagree with the
      // allow-list entry about what APP_URL pointed at.
      process.env.APP_URL = 'http://localhost:3000/';
      const next = makeNext();
      csrfProtection()(makeReq({ headers: { origin: 'http://localhost:5173' } }), makeRes(), next);
      expect(next).toHaveBeenCalledOnce();
    });
  });
});
