import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  fabFileRepository,
  adminSettingsRepository,
  scopedSettingsRepository,
  memoryLedgerRepository,
} from '@bike4mind/database';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

/**
 * GET /api/data-lakes/:id/health - derived, report-only lake health (#1666).
 *
 * Returns the four retrievability predicates and the reachable-content headline as RAW per-predicate
 * results; the UI derives the badge, so this contract stays stable when the presentation changes.
 * Also returns `duplicateMembers` (#2239): members sharing an exact fileName with a sibling in this
 * lake, report-only - and `membership` (#2245), the same lake graded over a wider population but a
 * narrower notion of duplicate, with the scope every number was computed as. The two overlap and
 * disagree by construction; see the note on LakeHealthApiResponse.membership.
 *
 * Both duplicate reports here are ruling-BLIND: a group an owner answered with "keep both" stays a
 * duplicate in this payload forever, because it genuinely is one. The surface that OFFERS a decision
 * reads GET /api/data-lakes/:id/membership-duplicates (#2238) instead, which is manage-gated and
 * suppresses what has already been answered. Do not drive an "N to resolve" affordance off this
 * route - it would re-ask a settled question on every render.
 *
 * `membership` is the WIRE shape: `toWireMembershipReport` drops the per-member `serverTextHash`,
 * `userId`, `relativePath` and `driveFileId` that the repair and admission arms reason over, since
 * the read gate below admits `public`.
 * Health is advisory and never blocks anything.
 *
 * Same read gate as GET /api/data-lakes/:id (owner/org/tag/public), with the not-found-style denial
 * so a caller cannot probe a lake's existence. Reader-visible: anyone who can read the lake can see
 * whether its content is findable. Computed on demand and cached client-side rather than folded into
 * recomputeLakeStats, which fires repeatedly during ingestion.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
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
        memoryLedger: memoryLedgerRepository,
      },
      logger: req.logger,
    });

    return res.json(health);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
