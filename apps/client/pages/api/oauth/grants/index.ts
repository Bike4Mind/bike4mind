import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { oauthGrantRepository, oauthClientRepository } from '@bike4mind/database';

/**
 * Self-service view of the OAuth clients this user has approved.
 *
 * GET - list active (non-revoked) grants for the caller, enriched with the client name.
 *       Scoped to req.user.id, so one user can never see another's grants.
 */
const handler = baseApi({ auth: 'jwtOnly' }).get(
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const grants = await oauthGrantRepository.listActiveByUser(userId);

    const clientMap = await oauthClientRepository.findByClientIds(grants.map(g => g.clientId));
    const enriched = grants.map(grant => ({
      clientId: grant.clientId,
      clientName: clientMap.get(grant.clientId)?.name ?? grant.clientId,
      scopes: grant.scopes,
      // updatedAt reflects the most-recent consent (upsertGrant always writes $set, which bumps it),
      // so after a revoke + re-approve the date shows the latest approval, not the first.
      approvedAt: grant.updatedAt,
    }));

    return res.status(200).json({ grants: enriched });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
