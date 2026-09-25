import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_OR_SHARE_SCOPES, assertDataLakeShareScope } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { lakeOwnershipOfferDb } from '@server/dataLakes/lakeOwnershipOfferDb';
import { sendLakeOwnershipOfferEmail } from '@server/utils/dataLakeOwnershipOfferNotifier';

/**
 * POST /api/data-lakes/ownership-offers/:offerId/decline -> { data: { id, status } }
 *
 * The recipient declines. Touches no grants - a pending offer never had one - and leaks nothing: a
 * caller who is not the named recipient gets a not-found.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_OR_SHARE_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request<{}, unknown, unknown, { offerId: string }>, res) => {
    assertDataLakeShareScope(req);
    const { offerId } = req.query;
    const ctx = await toAccessContext(req);

    const offer = await dataLakeService.declineLakeOwnershipOffer(ctx.userId, offerId, {
      db: lakeOwnershipOfferDb,
    });

    // After commit: tell the offerer the offer is closed. Best-effort.
    await sendLakeOwnershipOfferEmail(
      {
        kind: 'declined',
        toUserId: offer.offeredByUserId,
        dataLakeId: offer.dataLakeId,
        ...(req.user?.name || req.user?.username ? { counterpartName: req.user.name || req.user.username } : {}),
      },
      { logger: req.logger }
    );

    return res.json({ data: { id: offer.id, status: offer.status } });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
