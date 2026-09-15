import { blockedIPRepository } from '@bike4mind/database';
import { RequestHandler } from 'express';
import { getClientIp } from '@server/utils/ip';

/**
 * Middleware to check if the client's IP address is blocked
 * Returns appropriate response based on request type (redirect for web, JSON for API)
 */
export const checkBlockedIP = (): RequestHandler => {
  return async (req, res, next) => {
    try {
      const clientIp = getClientIp(req);
      const blockedIP = await blockedIPRepository.isBlocked(clientIp);

      if (blockedIP) {
        const errorMessage =
          'Your IP address has been temporarily blocked for 10 minutes due to repeated failed login attempts. Please try again after the block expires or contact support if you believe this is an error.';

        // Check if this is an API request (JSON) or web request (redirect)
        const acceptsJson = req.headers.accept?.includes('application/json');
        // Use req.path if available, otherwise parse from req.url
        const path = req.path || (req.url ? req.url.split('?')[0] : '');
        const isApiRequest = path.startsWith('/api/') && acceptsJson;

        if (isApiRequest) {
          return res.status(403).json({
            error: errorMessage,
            blocked: true,
            reason: blockedIP.reason,
            expiresAt: blockedIP.expiresAt,
            request_id: req.requestId,
          });
        }

        return res.redirect(`/login?error=${encodeURIComponent(errorMessage)}`);
      }

      next();
    } catch (error) {
      // If IP blocking check fails, log error but allow request to continue (fail open)
      // This prevents database issues from blocking all requests
      req.logger?.warn('Failed to check blocked IP, allowing request to continue', error);
      next();
    }
  };
};
