import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_OR_SHARE_SCOPES, assertDataLakeShareScope } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { withTransaction } from '@bike4mind/database';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { lakeOwnershipOfferDb } from '@server/dataLakes/lakeOwnershipOfferDb';
import { sendLakeOwnershipOfferEmail } from '@server/utils/dataLakeOwnershipOfferNotifier';

/**
 * POST /api/data-lakes/ownership-offers/:offerId/accept -> { data: { newOwnerUserId, demotedUserIds } }
 *
 * The recipient accepts a pending ownership offer, and ONLY then does ownership move. The service
 * refuses a caller who is not the named recipient with a not-found (no existence leak), and re-checks
 * expiry, the ownership snapshot, and both parties' org membership before applying.
 *
 * Wrapped in a transaction: the offer resolution and the grant writes must be one unit, so a failure
 * in the apply half cannot leave an accepted offer with no transfer behind it. There is no id in the
 * BODY - the offer id comes from the path and the recipient from auth, never from the request.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_OR_SHARE_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request<{}, unknown, unknown, { offerId: string }>, res) => {
    assertDataLakeShareScope(req);
    const { offerId } = req.query;
    const ctx = await toAccessContext(req);

    const result = await withTransaction(() =>
      dataLakeService.acceptLakeOwnershipOffer(ctx.userId, offerId, {
        db: lakeOwnershipOfferDb,
        logger: req.logger,
      })
    );

    const counterpartName = req.user?.name || req.user?.username;

    // After commit: tell the offerer. Best-effort - the offerer's address is not the recipient's
    // problem, and the notifier swallows its own failures.
    await sendLakeOwnershipOfferEmail(
      {
        kind: 'accepted',
        toUserId: result.offer.offeredByUserId,
        dataLakeId: result.offer.dataLakeId,
        ...(counterpartName ? { counterpartName } : {}),
      },
      { logger: req.logger }
    );

    // And tell each prior owner who was DEMOTED by this transfer - otherwise the org-admin succession
    // case moves ownership out from under someone who was party to it, the same consent gap the
    // offer exists to close, one party over. The offerer is skipped: they already have the mail above.
    for (const demotedUserId of result.demotedUserIds) {
      if (demotedUserId === result.offer.offeredByUserId) continue;
      await sendLakeOwnershipOfferEmail(
        {
          kind: 'accepted',
          toUserId: demotedUserId,
          dataLakeId: result.offer.dataLakeId,
          ...(counterpartName ? { counterpartName } : {}),
        },
        { logger: req.logger }
      );
    }

    return res.json({
      data: { newOwnerUserId: result.newOwnerUserId, demotedUserIds: result.demotedUserIds },
    });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
