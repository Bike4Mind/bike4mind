import type { UserRiskSignalType } from '@bike4mind/common';
import { Config } from '@bike4mind/server-utils/utils/config';
import { hkdfSync } from 'crypto';
import jwt from 'jsonwebtoken';

const PURPOSE = 'signup_form';
const AUDIENCE = 'signup-form';

// A purpose-derived key, so a form token and a JWT_SECRET-signed token can never stand in for each other.
let formTokenKey: Buffer | undefined;
const signupFormTokenKey = (): Buffer =>
  (formTokenKey ??= Buffer.from(hkdfSync('sha256', Config.JWT_SECRET, '', 'signup-form-token', 32)));

// issuedAtMs rather than iat: iat is whole seconds, too coarse for a sub-2s timing check.
export const signSignupFormToken = (nowMs = Date.now()): string =>
  jwt.sign({ purpose: PURPOSE, issuedAtMs: nowMs }, signupFormTokenKey(), {
    algorithm: 'HS256',
    expiresIn: '1h',
    audience: AUDIENCE,
  });

export function evaluateSignupSignals(input: {
  formToken?: unknown;
  formExtra?: unknown;
  nowMs: number;
  minSubmitMs: number;
}): UserRiskSignalType[] {
  const signals: UserRiskSignalType[] = [];
  if (typeof input.formExtra === 'string' && input.formExtra.length > 0) signals.push('signup_honeypot');

  if (typeof input.formToken !== 'string' || !input.formToken) {
    signals.push(
      input.formToken === undefined || input.formToken === '' ? 'signup_token_missing' : 'signup_token_invalid'
    );
    return signals;
  }

  try {
    const payload = jwt.verify(input.formToken, signupFormTokenKey(), {
      algorithms: ['HS256'],
      audience: AUDIENCE,
    }) as {
      purpose?: unknown;
      issuedAtMs?: unknown;
    };
    if (payload.purpose !== PURPOSE || typeof payload.issuedAtMs !== 'number') {
      signals.push('signup_token_invalid');
    } else if (input.nowMs - payload.issuedAtMs < input.minSubmitMs) {
      signals.push('signup_too_fast');
    }
  } catch (err) {
    // The signature is checked before expiry, so decode is trustworthy. A genuine expired token is a tab left
    // open, recorded but not actionable; expiry is checked before audience, so audience is re-checked here.
    if (err instanceof jwt.TokenExpiredError) {
      const decoded = jwt.decode(input.formToken) as { purpose?: unknown; aud?: unknown } | null;
      signals.push(
        decoded?.purpose === PURPOSE && decoded.aud === AUDIENCE ? 'signup_token_expired' : 'signup_token_invalid'
      );
      return signals;
    }
    if (err instanceof jwt.JsonWebTokenError) signals.push('signup_token_invalid');
    else throw err;
  }
  return signals;
}
