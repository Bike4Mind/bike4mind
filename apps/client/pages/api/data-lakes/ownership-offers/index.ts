import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_OR_SHARE_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { lakeOwnershipOfferDb } from '@server/dataLakes/lakeOwnershipOfferDb';

/**
 * GET /api/data-lakes/ownership-offers -> { data: LakeOwnershipOfferSummary[] }
 *
 * The RECIPIENT's own pending ownership offers - the surface behind the manager banner. Scoped to
 * the authenticated caller by construction: the query is `recipientUserId === ctx.userId`, so there
 * is no id to guess and no existence to leak.
 *
 * Deliberately a narrow projection (lake name, offerer display name, expiry, the content gate): the
 * recipient may not be able to read the lake yet, and an offer must not become a back door onto its
 * contents or its member roster.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_OR_SHARE_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request, res) => {
    const ctx = await toAccessContext(req);
    const data = await dataLakeService.listLakeOwnershipOffersForRecipient(ctx.userId, {
      db: lakeOwnershipOfferDb,
    });
    return res.json({ data });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
