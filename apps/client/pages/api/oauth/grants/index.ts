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

    const enriched = await Promise.all(
      grants.map(async grant => {
        const client = await oauthClientRepository.findByClientId(grant.clientId);
        return {
          clientId: grant.clientId,
          clientName: client?.name ?? grant.clientId,
          scopes: grant.scopes,
          grantedAt: grant.createdAt,
        };
      })
    );

    return res.status(200).json({ grants: enriched });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
