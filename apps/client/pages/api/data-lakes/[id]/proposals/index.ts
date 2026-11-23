import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES } from '@bike4mind/server-utils/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { DATA_LAKE_PROPOSAL_STATUSES, lakeProposalListResponseSchema } from '@bike4mind/common';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@bike4mind/server-utils/dataLakes/toAccessContext';
import { listLakeProposals } from '@server/dataLakes/research/proposalListHandler';
import { respond } from '@server/utils/respond';

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
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const { status, limit } = ListQuery.parse(req.query);
    const proposals = await listLakeProposals(req, id, await toAccessContext(req), 'data-lake-proposals', () => ({
      status,
      limit: limit ?? DEFAULT_LIMIT,
    }));
    return respond(res, lakeProposalListResponseSchema, { data: proposals });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
