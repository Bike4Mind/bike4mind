import type { UserRiskSignalType } from '@bike4mind/common';
import { Config } from '@bike4mind/server-utils/utils/config';
import jwt from 'jsonwebtoken';

const PURPOSE = 'signup_form';

// issuedAtMs rather than iat: iat is whole seconds, too coarse for a sub-2s timing check.
export const signSignupFormToken = (nowMs = Date.now()): string =>
  jwt.sign({ purpose: PURPOSE, issuedAtMs: nowMs }, Config.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

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
    const payload = jwt.verify(input.formToken, Config.JWT_SECRET, { algorithms: ['HS256'] }) as {
      purpose?: unknown;
      issuedAtMs?: unknown;
    };
    if (payload.purpose !== PURPOSE || typeof payload.issuedAtMs !== 'number') {
      signals.push('signup_token_invalid');
    } else if (input.nowMs - payload.issuedAtMs < input.minSubmitMs) {
      signals.push('signup_too_fast');
    }
  } catch (err) {
    // An expired token means the tab was left open, not automation.
    if (err instanceof jwt.TokenExpiredError) return signals;
    if (err instanceof jwt.JsonWebTokenError) signals.push('signup_token_invalid');
    else throw err;
  }
  return signals;
}
