import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  fabFileRepository,
  adminSettingsRepository,
  scopedSettingsRepository,
} from '@bike4mind/database';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

/**
 * GET /api/data-lakes/:id/health - derived, report-only lake health (#1666).
 *
 * Returns the four retrievability predicates and the reachable-content headline as RAW per-predicate
 * results; the UI derives the badge, so this contract stays stable when the presentation changes.
 * Health is advisory and never blocks anything.
 *
 * Same read gate as GET /api/data-lakes/:id (owner/org/tag/public), with the not-found-style denial
 * so a caller cannot probe a lake's existence. Reader-visible: anyone who can read the lake can see
 * whether its content is findable. Computed on demand and cached client-side rather than folded into
 * recomputeLakeStats, which fires repeatedly during ingestion.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });

    const health = await dataLakeService.computeLakeHealth(lake, {
      db: {
        fabFiles: fabFileRepository,
        adminSettings: adminSettingsRepository,
        scopedSettings: scopedSettingsRepository,
      },
      logger: req.logger,
    });

    return res.json(health);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
