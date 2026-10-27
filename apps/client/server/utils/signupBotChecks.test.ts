import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { evaluateSignupSignals, signSignupFormToken } from './signupBotChecks';

vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { JWT_SECRET: 'test-secret' } }));

const NOW = 1_700_000_000_000;
const MIN = 1500;
const evaluate = (input: { formToken?: unknown; formExtra?: unknown; nowMs?: number }) =>
  evaluateSignupSignals({ nowMs: NOW + 5000, minSubmitMs: MIN, ...input });

describe('evaluateSignupSignals', () => {
  it('returns no signals for a valid, slow, honeypot-free submission', () => {
    expect(evaluate({ formToken: signSignupFormToken(NOW), formExtra: '' })).toEqual([]);
  });

  it('flags a filled honeypot', () => {
    expect(evaluate({ formToken: signSignupFormToken(NOW), formExtra: 'x' })).toEqual(['signup_honeypot']);
  });

  it('flags a missing token', () => {
    expect(evaluate({})).toEqual(['signup_token_missing']);
    expect(evaluate({ formToken: '' })).toEqual(['signup_token_missing']);
  });

  it('flags garbage, wrong-secret and wrong-purpose tokens as invalid', () => {
    const wrongSecret = jwt.sign({ purpose: 'signup_form', issuedAtMs: NOW }, 'other', { algorithm: 'HS256' });
    const pendingOtc = jwt.sign({ email: 'a@b.co', attempts: 0, jti: 'j' }, 'test-secret', { algorithm: 'HS256' });
    for (const formToken of ['garbage', wrongSecret, pendingOtc, 123]) {
      expect(evaluate({ formToken })).toEqual(['signup_token_invalid']);
    }
  });

  it('flags a submission faster than the minimum', () => {
    expect(evaluate({ formToken: signSignupFormToken(NOW), nowMs: NOW + MIN - 1 })).toEqual(['signup_too_fast']);
    expect(evaluate({ formToken: signSignupFormToken(NOW), nowMs: NOW + MIN })).toEqual([]);
  });

  it('gives no signal for a recently expired token', () => {
    const expired = jwt.sign({ purpose: 'signup_form', issuedAtMs: NOW }, 'test-secret', {
      algorithm: 'HS256',
      expiresIn: -10,
    });
    expect(evaluate({ formToken: expired })).toEqual([]);
  });

  it('flags an expired token signed with the secret but a different purpose', () => {
    const expired = jwt.sign({ sub: 'user-1' }, 'test-secret', { algorithm: 'HS256', expiresIn: -3600 });
    expect(evaluate({ formToken: expired })).toEqual(['signup_token_invalid']);
  });

  it('flags a token expired longer than the grace window as invalid', () => {
    const exp = Math.floor(NOW / 1000) - 3600;
    const stale = jwt.sign({ purpose: 'signup_form', issuedAtMs: NOW - 7_200_000, exp }, 'test-secret', {
      algorithm: 'HS256',
    });
    expect(evaluate({ formToken: stale, nowMs: exp * 1000 + 24 * 3_600_000 })).toEqual([]);
    expect(evaluate({ formToken: stale, nowMs: exp * 1000 + 24 * 3_600_000 + 1 })).toEqual(['signup_token_invalid']);
  });

  it('flags a not-yet-valid token as invalid', () => {
    const early = jwt.sign({ purpose: 'signup_form', issuedAtMs: NOW }, 'test-secret', {
      algorithm: 'HS256',
      notBefore: 3600,
    });
    expect(evaluate({ formToken: early })).toEqual(['signup_token_invalid']);
  });

  it('rethrows errors that are not token errors', () => {
    const spy = vi.spyOn(jwt, 'verify').mockImplementation(() => {
      throw new Error('boom');
    });
    try {
      expect(() => evaluate({ formToken: 'x.y.z' })).toThrow('boom');
    } finally {
      spy.mockRestore();
    }
  });

  it('combines honeypot and too-fast', () => {
    expect(evaluate({ formToken: signSignupFormToken(NOW), formExtra: 'x', nowMs: NOW + 10 })).toEqual([
      'signup_honeypot',
      'signup_too_fast',
    ]);
  });
});
