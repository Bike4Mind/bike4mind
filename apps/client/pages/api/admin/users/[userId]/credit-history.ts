import { userRepository } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ensureAdmin, NotFoundError } from '@server/utils/errors';
import { getUserCreditHistory } from '@server/utils/userActivity';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/** The 90-day balance series behind the Activity tab's chart, rebuilt backward from the credit ledger. */
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);

  const { userId } = req.query;
  if (typeof userId !== 'string' || !OBJECT_ID_PATTERN.test(userId)) throw new BadRequestError('Invalid user id');

  // The ledger sum is bounded at the instant the balance is read, so rows written between the two
  // reads cannot land in a day's net without also being in the balance it is walked back from.
  const balanceAsOf = new Date();
  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  return res.json(await getUserCreditHistory({ id: user.id, currentCredits: user.currentCredits ?? 0 }, balanceAsOf));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
