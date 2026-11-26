import { UnauthorizedError } from '@bike4mind/utils';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { assertCallableFunctionsEnabled } from '@bike4mind/server-utils/callableFunctions/access';
import { findCallableFunctionRecipient } from '@bike4mind/server-utils/callableFunctions/sharing';
import { baseApi } from '@server/middlewares/baseApi';

// Lower than the general address lookup, since this one reaches every account rather than the caller's organizations.
const RECIPIENT_RATE_LIMIT = { limit: 20, windowMs: 60 * 1000, bucket: 'callable-functions-recipient' } as const;

const one = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * GET ?email= - the account holding exactly that address, `{ id, name }`, for the owner of function [id] to name in a
 * share; null when no account has it. Owner only: another person's function reads as not found.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit(RECIPIENT_RATE_LIMIT))
  .get(async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    await assertCallableFunctionsEnabled(req.user);
    res.json(await findCallableFunctionRecipient(req.user, one(req.query.id), one(req.query.email)));
  });

export default handler;
