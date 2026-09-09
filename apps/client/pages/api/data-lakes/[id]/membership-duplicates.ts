import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  fabFileRepository,
  lakeMembershipDecisionRepository,
} from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

/**
 * GET /api/data-lakes/:id/membership-duplicates
 *
 * The duplicate groups in this lake that nobody has answered yet (#2238) - the read the decision
 * surface renders, answered by POST /api/data-lakes/:id/membership-decisions.
 *
 * Separate from GET .../health, which reports duplicates too, for two reasons. Health is
 * ruling-BLIND on purpose (it describes the lake, not the conversation about it), and health admits
 * `public` readers while this is MANAGE-gated - what is still open to decide names the copies a
 * manager is about to remove, and matches the gate on the POST that acts on it.
 *
 * See `loadMembershipRepairPlan` for why a recorded ruling has to suppress a group here: `keep-both`
 * leaves the group intact, so without suppression the one answer meaning "stop asking" would be
 * re-asked forever.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });

    // Refused on the READ as well as the POST: a built-in lake's duplicates are not answerable, and a
    // surface that offers a question the decision door will reject is worse than one that stays quiet.
    dataLakeService.assertLakeWritable(lake);

    const canManage = await dataLakeService.resolveCanManageLake(lake, ctx, {
      db: { dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    if (!canManage) {
      throw new BadRequestError('You do not have permission to resolve duplicates in this data lake');
    }

    const plan = await dataLakeService.loadMembershipRepairPlan(lake, {
      db: { fabFiles: fabFileRepository, lakeMembershipDecisions: lakeMembershipDecisionRepository },
      logger: req.logger,
    });

    return res.json(plan);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
