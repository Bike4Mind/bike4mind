/**
 * GET /api/v1/delegations/{id} - read one delegated item. Another user's item is `404`, like a missing one.
 */
import { ForbiddenError, NotFoundError, getDelegationContract } from '@bike4mind/common';
import { delegatedItemRepository } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { serializeDelegation } from '@server/delegations/serializeDelegation';

const route = nextRouteForContract(getDelegationContract, {
  rateLimit: perUserRateLimit('GET /api/v1/delegations/[id]'),
  // Polling one item should not spend a daily slot per poll; the per-minute burst limit still applies.
  exemptReadsFromDailyRateLimit: true,
  recordsActivity: false,
}).get(async (req, res) => {
  if (req.apiKeyInfo?.oauthExchangeClientId) {
    throw new ForbiddenError('Keys minted for a connected app cannot read delegations');
  }
  const item = await delegatedItemRepository.findByIdForUser(req.validatedParams.id, req.user.id);
  if (!item) throw new NotFoundError('Delegation not found');
  return res.json(serializeDelegation(item));
});

export const config = {
  api: { externalResolver: true },
};

export default route;
