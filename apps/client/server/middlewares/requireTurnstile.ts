import { Request, RequestHandler, Response } from 'express';
import { Resource } from 'sst';
import { isDevelopment, isE2EEnabled, isProduction } from '@bike4mind/server-utils/utils/config';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';
import { isTurnstileTestSecret, verifyTurnstile } from '@bike4mind/server-utils/utils/turnstile';
import { getTurnstilePolicy, turnstileAllowedHostnames, type TurnstilePolicy } from '@server/utils/auth/turnstile';

export type TurnstileFailure = {
  code: 'challenge_failed' | 'challenge_unavailable';
  status: 403 | 503;
  error: string;
};

export type RequireTurnstileOptions = {
  /** Where the token travels; defaults to `turnstileToken` in the JSON body. */
  token?: (req: Request) => unknown;
  /** Requests the policy does not apply to even while active, decided per request. */
  exempt?: (req: Request) => boolean;
  /** Replaces the JSON error answer, for routes a browser navigates to directly. */
  onFailure?: (req: Request, res: Response, failure: TurnstileFailure) => void;
};

const UNAVAILABLE: TurnstileFailure = {
  code: 'challenge_unavailable',
  status: 503,
  error: 'Verification is temporarily unavailable. Please try again.',
};
const FAILED: TurnstileFailure = {
  code: 'challenge_failed',
  status: 403,
  error: 'Verification failed. Please refresh and try again.',
};

/**
 * Rejects the request with 403 `challenge_failed` unless it carries a valid Turnstile token
 * for `action`. A no-op while the feature is off or unprovisioned. Only a verification outage is
 * governed by the fail-closed setting; a missing or invalid token always fails. The token is never logged.
 */
export const requireTurnstile = (action: string, options: RequireTurnstileOptions = {}): RequestHandler => {
  const readToken = options.token ?? (req => req.body?.turnstileToken);
  const fail = (req: Request, res: Response, failure: TurnstileFailure) => {
    if (options.onFailure) return options.onFailure(req, res, failure);
    res.status(failure.status).json({ error: failure.error, code: failure.code, request_id: req.requestId });
  };
  return async (req, res, next) => {
    if (options.exempt?.(req)) return next();
    const policy = await getTurnstilePolicy().catch(error => {
      req.logger?.warn('turnstile-policy-unreadable', error);
      fail(req, res, UNAVAILABLE);
      return null;
    });
    if (!policy) return;
    if (!policy.active) return next();
    if (isE2ETestRequest(req)) return next();

    const failure = await checkTurnstileToken(req, action, policy, readToken(req));
    if (failure) return fail(req, res, failure);
    return next();
  };
};

/**
 * Verifies `token` for `action` under an active `policy`: null when it passes (or verification is
 * down and the policy fails open), else the failure to answer with. The token is never logged.
 */
export async function checkTurnstileToken(
  req: Request,
  action: string,
  policy: TurnstilePolicy,
  token: unknown
): Promise<TurnstileFailure | null> {
  const ip = getClientIp(req);
  // A public test secret rejects every token on production (strict checks stay) and admits anyone
  // on other stages. Local development is where it belongs, so only deployed stages log it.
  const production = isProduction();
  const testSecret = isTurnstileTestSecret(policy.secret);
  if (testSecret && production) {
    req.logger?.error('turnstile-test-secret-in-production', { action });
  } else if (testSecret && !isDevelopment()) {
    req.logger?.warn('turnstile-test-secret-on-deployed-stage', { action });
  }
  const result = await verifyTurnstile({
    token,
    secret: policy.secret,
    ip,
    expectedAction: action,
    allowedHostnames: turnstileAllowedHostnames(),
    allowTestSecret: !production,
  });
  if (result.ok) return null;

  if (result.reason === 'unavailable' && !policy.failClosed) {
    req.logger?.warn('turnstile-unavailable-fail-open', { ip, action });
    return null;
  }

  req.logger?.warn('turnstile-challenge-failed', {
    ip,
    action,
    reason: result.reason,
    errorCodes: result.errorCodes,
  });
  return FAILED;
}

/**
 * Playwright cannot solve a real challenge, so e2e skips it behind the same three guards as
 * /api/test/otc-code: a non-production stage, the shared E2E secret header and a -e2e@test.com
 * email. Real users on the stage are still challenged. Must stay in sync with that endpoint.
 */
function isE2ETestRequest(req: Request): boolean {
  if (!isE2EEnabled()) return false;
  const expected = Resource.E2E_CLEANUP_SECRET?.value || process.env.E2E_CLEANUP_SECRET;
  if (!expected || expected === 'not-configured' || req.headers?.['x-e2e-cleanup-secret'] !== expected) return false;
  const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase().trim() : '';
  return /-e2e@test\.com$/i.test(email);
}
