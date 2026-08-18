import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, dataLakeAccessGrantRepository, fallbackLakeSettingsRepository } from '@bike4mind/database';
import { UpdateFallbackLakeSettingsRequestInput } from '@bike4mind/common';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

/**
 * PUT /api/data-lakes/:id/settings - edit a STATIC (registry) lake's admin-settable overlay
 * (currently `groundingMode` only - see IFallbackLakeSetting). A separate route from PUT
 * /api/data-lakes/:id on purpose: that route's `assertLakeWritable` refuses fallback lakes
 * wholesale (there is no document for it to mutate), and this route's gate
 * (`assertFallbackLakeSettingsWriteAccess`) refuses the opposite direction - a persisted DB lake
 * must keep going through the ordinary update path so the two routes can never both claim to own
 * a lake's settings.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .put(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const params = UpdateFallbackLakeSettingsRequestInput.parse(req.body);
    const ctx = await toAccessContext(req);

    const updated = await dataLakeService.updateFallbackLakeSettings(id, ctx, params, {
      db: {
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        fallbackLakeSettings: fallbackLakeSettingsRepository,
      },
    });

    return res.json(updated);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
