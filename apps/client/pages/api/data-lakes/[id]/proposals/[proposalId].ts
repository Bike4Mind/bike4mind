import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_WRITE_SCOPES } from '@bike4mind/server-utils/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { lakeProposalApproveResponseSchema, lakeProposalReviewResponseSchema } from '@bike4mind/common';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@bike4mind/server-utils/dataLakes/toAccessContext';
import { decideLakeProposal } from '@server/dataLakes/research/proposalHandlers';
import { respond } from '@server/utils/respond';

const ReviewInput = z.object({
  decision: z.enum(['approve', 'decline', 'restore']),
  /** Recorded on the tombstone so a later reviewer can see why this source was refused. */
  reason: z.string().trim().max(500).optional(),
});

/**
 * POST /api/data-lakes/:id/proposals/:proposalId - rule on one acquisition proposal, or
 * `restore` a declined one to the pending queue.
 *
 * The manual way content a producer found reaches a lake. The only automatic way is a trusted-site
 * rule on the research config, applied by the worker, never by a score. Authorization,
 * writability, the once-only claim and the admission itself all live in the service; the shared
 * handler body (`server/dataLakes/research/proposalHandlers`) resolves the actor, checks the
 * proposal belongs to the lake in the path, and wires the ordinary URL ingestion door as the
 * admission adapter.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_WRITE_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request, res) => {
    const { id, proposalId } = req.query as { id: string; proposalId: string };
    const input = ReviewInput.parse(req.body);
    const ctx = await toAccessContext(req);

    const result = await decideLakeProposal(req, id, proposalId, ctx, () => input);
    if (result.decision === 'approve') {
      return respond(res, lakeProposalApproveResponseSchema, { data: result.proposal, fabFile: result.fabFile });
    }
    return respond(res, lakeProposalReviewResponseSchema, { data: result.proposal });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
