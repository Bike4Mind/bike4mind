import { RequestHandler } from 'express';
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
      return null;
    });
    if (!policy?.active) return next();

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
