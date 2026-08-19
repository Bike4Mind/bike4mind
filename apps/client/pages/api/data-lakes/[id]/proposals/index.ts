import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, dataLakeAccessGrantRepository, dataLakeProposalRepository } from '@bike4mind/database';
import { DATA_LAKE_PROPOSAL_STATUSES } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

const ListQuery = z.object({
  status: z.enum(DATA_LAKE_PROPOSAL_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** Bounds one page of the queue when a caller does not ask for a size. */
const DEFAULT_LIMIT = 50;

/**
 * GET /api/data-lakes/:id/proposals - one lake's acquisition review queue (#1671).
 *
 * MANAGE-gated, not read-gated: a proposal carries an excerpt of external content that no human has
 * vetted yet, and deciding what enters a lake is a management right. Anyone who can merely read the
 * lake gets the same denial as a non-reader would - the lake read gate runs first, so the refusal
 * for a stranger stays not-found-style and leaks no existence.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const { status, limit } = ListQuery.parse(req.query);
    const ctx = await toAccessContext(req);

    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    const canManage = await dataLakeService.resolveCanManageLake(lake, ctx, {
      db: { dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    if (!canManage) {
      throw new BadRequestError('You do not have permission to review proposals for this data lake');
    }

    const proposals = await dataLakeProposalRepository.listByLake(lake.id, {
      status,
      limit: limit ?? DEFAULT_LIMIT,
    });

    return res.json({ data: proposals });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
