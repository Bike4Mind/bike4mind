import { Request, RequestHandler } from 'express';
import { Resource } from 'sst';
import { isE2EEnabled } from '@bike4mind/server-utils/utils/config';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';
import { verifyTurnstile } from '@bike4mind/server-utils/utils/turnstile';
import { getTurnstilePolicy, turnstileAllowedHostnames } from '@server/utils/auth/turnstile';

/**
 * Rejects the request with 403 `challenge_failed` unless the body carries a valid Turnstile token
 * for `action`. A no-op while the feature is off or unprovisioned. Only a verification outage is
 * governed by the fail-closed setting; a missing or invalid token always fails. The token is never logged.
 */
export const requireTurnstile = (action: string): RequestHandler => {
  return async (req, res, next) => {
    const policy = await getTurnstilePolicy().catch(error => {
      req.logger?.warn('turnstile-policy-unreadable', error);
      res.status(503).json({
        error: 'Verification is temporarily unavailable. Please try again.',
        code: 'challenge_unavailable',
        request_id: req.requestId,
      });
      return null;
    });
    if (!policy) return;
    if (!policy.active) return next();
    if (isE2ETestRequest(req)) return next();

    const ip = getClientIp(req);
    const result = await verifyTurnstile({
      token: req.body?.turnstileToken,
      secret: policy.secret,
      ip,
      expectedAction: action,
      allowedHostnames: turnstileAllowedHostnames(),
    });
    if (result.ok) return next();

    if (result.reason === 'unavailable' && !policy.failClosed) {
      req.logger?.warn('turnstile-unavailable-fail-open', { ip, action });
      return next();
    }

    req.logger?.warn('turnstile-challenge-failed', {
      ip,
      action,
      reason: result.reason,
      errorCodes: result.errorCodes,
    });
    return res.status(403).json({
      error: 'Verification failed. Please refresh and try again.',
      code: 'challenge_failed',
      request_id: req.requestId,
    });
  };
};

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
