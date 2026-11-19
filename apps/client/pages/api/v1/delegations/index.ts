/**
 * POST /api/v1/delegations - delegate an item to the assistant (asynchronous; 202 with the item `pending`).
 */
import { ForbiddenError, createDelegationContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { createDelegation } from '@server/delegations/createDelegation';
import { serializeDelegation } from '@server/delegations/serializeDelegation';

const route = nextRouteForContract(createDelegationContract).post(async (req, res) => {
  // A delegation spends the user's credits and reads the user's files, which a connected app is not granted.
  if (req.apiKeyInfo?.oauthExchangeClientId) {
    throw new ForbiddenError('Keys minted for a connected app cannot delegate');
  }
  const item = await createDelegation(req.user.id, req.validated);
  return res.status(202).json(serializeDelegation(item));
});

export const config = {
  api: { externalResolver: true },
};

export default route;
