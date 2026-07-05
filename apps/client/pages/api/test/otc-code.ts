import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { isE2EEnabled } from '@server/utils/config';
import { pendingOtcTokenRepository } from '@bike4mind/database';
import { Resource } from 'sst';
import { Request } from 'express';

/**
 * TEST-ONLY: returns the plaintext OTC last emailed to a test account, so Playwright
 * (MCP + CI automation) can complete the passwordless login/registration flow without
 * a mailbox. Mirrors /api/test/create-user's gating.
 *
 * Guards (defense-in-depth):
 *  1. isE2EEnabled() - hard-false on production, so this endpoint 404s there and the
 *     plaintext code is never even stored (see /api/otc/send).
 *  2. Shared E2E secret header.
 *  3. Only test-pattern (-e2e@test.com) emails - can never reveal a real user's code.
 */
const handler = baseApi({ auth: false }).get(
  asyncHandler(async (req: Request, res) => {
    // Guard 1: non-production only. Return 404 (not 403) so the endpoint is indistinguishable
    // from "does not exist" on production.
    if (!isE2EEnabled()) {
      return res.status(404).json({ error: 'Not found' });
    }

    // Guard 2: shared secret
    const secret = req.headers['x-e2e-cleanup-secret'];
    const expectedSecret = Resource.E2E_CLEANUP_SECRET?.value || process.env.E2E_CLEANUP_SECRET;
    if (!expectedSecret || expectedSecret === 'not-configured' || secret !== expectedSecret) {
      return res.status(401).json({ error: 'Invalid cleanup secret' });
    }

    const emailRaw = req.query.email;
    const email = typeof emailRaw === 'string' ? emailRaw.toLowerCase().trim() : '';
    if (!email) {
      return res.status(400).json({ error: 'email query parameter is required' });
    }

    // Guard 3: only reveal codes for test-pattern accounts, never real users
    if (!/-e2e@test\.com$/i.test(email)) {
      return res.status(400).json({ error: 'otc-code is only available for -e2e@test.com accounts' });
    }

    const code = await pendingOtcTokenRepository.getDebugCode(email);
    if (!code) {
      return res.status(404).json({ error: 'No pending code for this email (expired or never requested)' });
    }

    return res.status(200).json({ code });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
