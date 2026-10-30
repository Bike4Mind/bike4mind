import { describe, it, expect, vi } from 'vitest';
import { hkdfSync } from 'crypto';
import jwt from 'jsonwebtoken';
import { evaluateSignupSignals, signSignupFormToken } from './signupBotChecks';

vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { JWT_SECRET: 'test-secret' } }));

const NOW = 1_700_000_000_000;
const MIN = 1500;
const KEY = Buffer.from(hkdfSync('sha256', 'test-secret', '', 'signup-form-token', 32));
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

  it('flags garbage, wrong-key and wrong-purpose tokens as invalid', () => {
    const wrongSecret = jwt.sign({ purpose: 'signup_form', issuedAtMs: NOW }, 'other', {
      algorithm: 'HS256',
      audience: 'signup-form',
    });
    const pendingOtc = jwt.sign({ email: 'a@b.co', attempts: 0, jti: 'j' }, 'test-secret', { algorithm: 'HS256' });
    const rawSecret = jwt.sign({ purpose: 'signup_form', issuedAtMs: NOW }, 'test-secret', {
      algorithm: 'HS256',
      audience: 'signup-form',
    });
    for (const formToken of ['garbage', wrongSecret, rawSecret, pendingOtc, 123]) {
      expect(evaluate({ formToken })).toEqual(['signup_token_invalid']);
    }
  });

  it('flags a submission faster than the minimum', () => {
    expect(evaluate({ formToken: signSignupFormToken(NOW), nowMs: NOW + MIN - 1 })).toEqual(['signup_too_fast']);
    expect(evaluate({ formToken: signSignupFormToken(NOW), nowMs: NOW + MIN })).toEqual([]);
  });

  it('flags a genuine expired token as expired regardless of age', () => {
    for (const ageS of [7200, 25 * 3600]) {
      const expired = jwt.sign({ purpose: 'signup_form', issuedAtMs: NOW }, KEY, {
        algorithm: 'HS256',
        audience: 'signup-form',
        expiresIn: -ageS,
      });
      expect(evaluate({ formToken: expired })).toEqual(['signup_token_expired']);
    }
  });

  it('flags an expired token signed with the secret but a different purpose as invalid', () => {
    const expired = jwt.sign({ sub: 'user-1' }, KEY, {
      algorithm: 'HS256',
      audience: 'signup-form',
      expiresIn: -3600,
    });
    expect(evaluate({ formToken: expired })).toEqual(['signup_token_invalid']);
  });

  it('flags tokens without the signup-form audience as invalid, expired or not', () => {
    const claims = { purpose: 'signup_form', issuedAtMs: NOW };
    const live = jwt.sign(claims, KEY, { algorithm: 'HS256' });
    const wrongAud = jwt.sign(claims, KEY, { algorithm: 'HS256', audience: 'other' });
    const expired = jwt.sign(claims, KEY, { algorithm: 'HS256', expiresIn: -3600 });
    for (const formToken of [live, wrongAud, expired]) {
      expect(evaluate({ formToken })).toEqual(['signup_token_invalid']);
    }
  });

  it('flags a not-yet-valid token as invalid', () => {
    const early = jwt.sign({ purpose: 'signup_form', issuedAtMs: NOW }, KEY, {
      algorithm: 'HS256',
      audience: 'signup-form',
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
