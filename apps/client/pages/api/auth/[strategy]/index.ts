// GET /api/auth/<service>
//   - Authenticate using any service

import passport from '@server/auth/auth';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';

const SERVICES: { [service: string]: { scope: string[] | string } } = {
  google: {
    scope: ['profile', 'email'],
  },
  facebook: {
    scope: ['public_profile', 'email'],
  },
  github: {
    scope: ['user', 'user:email'],
  },
  okta: {
    scope: ['openid', 'profile', 'email'],
  },
};

/**
 * Authentication API for various providers
 *
 * This API handles authentication requests for multiple third-party providers
 * such as Google, Facebook, GitHub, and Okta. It uses Passport.js for
 * authentication strategies.
 *
 * Endpoint: GET /api/auth/<service>
 *
 * @param {string} service - The name of the authentication service (e.g., 'google', 'facebook')
 * @returns {void} - Redirects to the appropriate authentication page for the specified service
 */
const handler = baseApi({ auth: false }).get(
  asyncHandler<{}, unknown, unknown, { strategy: string }>(async (req, res, next) => {
    const { strategy } = req.query;

    if (!strategy || !Object.keys(SERVICES).includes(strategy)) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    // In dev, derive callback URL from the actual request host so OAuth
    // redirects back to the correct port (Next.js may not be on :3000)
    const authenticateOptions: Record<string, unknown> = { scope: SERVICES[strategy].scope };
    if (process.env.APP_URL?.includes('localhost')) {
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers.host || 'localhost:3000';
      authenticateOptions.callbackURL = `${protocol}://${host}/api/auth/${strategy}/callback`;
    }

    passport.authenticate(strategy, authenticateOptions)(req, res, next);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
