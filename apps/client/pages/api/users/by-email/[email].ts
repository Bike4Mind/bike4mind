import { User } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { baseApi } from '@server/middlewares/baseApi';
import { Request } from 'express';
import { Types } from 'mongoose';

// Per user: rateLimit keys on req.user.id because it runs after baseApi's auth. A members list
// resolves one pending invite per row, so the cap leaves room for a long list.
const BY_EMAIL_RATE_LIMIT = { limit: 60, windowMs: 60 * 1000, bucket: 'users-by-email' } as const;

// A fresh id no account holds: with no match the membership query still runs, so every request runs the same queries.
const unmatchedUserId = () => new Types.ObjectId().toHexString();

/**
 * Exact-email lookup for share-by-address flows (skill share dialog, pending-invite cards).
 * Resolves only users who share an organization with the caller, and answers `null` for every
 * other address, so the response is the same whether or not an account has it.
 * Returns only the id and display name; the caller already has the address, so it is not echoed.
 */
const handler = baseApi()
  .use(rateLimit(BY_EMAIL_RATE_LIMIT))
  .get<Request<{}, unknown, unknown, { email: string }>>(async (req, res) => {
    const user = await User.findOne({ email: req.query.email }).select('name');
    const inScope = await organizationRepository.sharesMembership(req.user.id, user?.id ?? unmatchedUserId());
    return res.json(user && inScope ? { id: user.id, name: user.name } : null);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
