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
    it('calls next() when x-api-key header is present', () => {
      const next = makeNext();
      csrfProtection()(makeReq({ headers: { 'x-api-key': 'b4m_live_somekey' } }), makeRes(), next);
      expect(next).toHaveBeenCalledOnce();
    });

    it('does not reach origin check when x-api-key is present — even with a cross-site Sec-Fetch-Site', () => {
      const next = makeNext();
      csrfProtection()(
        makeReq({ headers: { 'x-api-key': 'b4m_live_somekey', 'sec-fetch-site': 'cross-site' } }),
        makeRes(),
        next
      );
      expect(next).toHaveBeenCalledOnce();
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
  });
});
