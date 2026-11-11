import { creditTransactionRepository, shadowDetectionRepository, userRepository } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { findDetectionLinkedAccounts } from '@server/admin/detectionLinkedAccounts';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/**
 * Accounts that cohort shadow detections name together with this user. Read-only, so support:read,
 * like the shadow-detection reads (pages/api/admin/shadow-detections/index.ts).
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'support:read' },
}).get(async (req, res) => {
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
