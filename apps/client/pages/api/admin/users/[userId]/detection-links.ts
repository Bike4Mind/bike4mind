import { creditTransactionRepository, shadowDetectionRepository, userRepository } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ensureAdmin, NotFoundError } from '@server/utils/errors';
import { findDetectionLinkedAccounts } from '@server/admin/detectionLinkedAccounts';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/** Accounts that cohort shadow detections name together with this user. */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);

  const { userId } = req.query;
  if (typeof userId !== 'string' || !OBJECT_ID_PATTERN.test(userId)) throw new BadRequestError('Invalid user id');

  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const links = await findDetectionLinkedAccounts(user.id, {
    listDetections: (id, query) => shadowDetectionRepository.listForUser(id, query),
    findLinkStates: ids => userRepository.findLinkStatesByIds(ids),
    aiSpendSince: (ids, ownerType, since) => creditTransactionRepository.aiSpendByOwnersSince(ids, ownerType, since),
    countActiveApiKeys: ids => userApiKeyRepository.countActiveByUserIds(ids),
    now: () => new Date(),
  });
  return res.json(links);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
