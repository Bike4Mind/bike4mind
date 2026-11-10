import { User } from '@bike4mind/database';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { baseApi } from '@server/middlewares/baseApi';
import { Request } from 'express';

// Per user: rateLimit keys on req.user.id because it runs after baseApi's auth. A members list
// resolves one pending invite per row, so the cap leaves room for a long list.
const BY_EMAIL_RATE_LIMIT = { limit: 60, windowMs: 60 * 1000, bucket: 'users-by-email' } as const;

/**
 * Exact-email lookup for share-by-address flows (skill share dialog, pending-invite cards).
 * Returns only the id and display name; the caller already has the address, so it is not echoed.
 */
const handler = baseApi()
  .use(rateLimit(BY_EMAIL_RATE_LIMIT))
  .get<Request<{}, unknown, unknown, { email: string }>>(async (req, res) => {
    const user = await User.findOne({ email: req.query.email }).select('name');
    return res.json(user ? { id: user.id, name: user.name } : null);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
