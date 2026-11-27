/**
 * POST /api/v1/data-lakes/{id}/proposals/{proposal_id} - approve, decline or restore one proposal
 * (`decideDataLakeProposalContract`).
 *
 * Public twin of POST /api/data-lakes/:id/proposals/:proposalId on the same handler body. A
 * malformed `proposal_id` is a 404 after the lake gate, not a CastError.
 */
import { decideDataLakeProposalContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { toMemberAccessContext } from '@bike4mind/server-utils/dataLakes/toAccessContext';
import { decideLakeProposal } from '@server/dataLakes/research/proposalHandlers';
import { researchRateLimit } from '@server/dataLakes/research/v1Shared';
import { toPublicProposal } from '@server/dataLakes/toPublicResearch';

const handler = nextRouteForContract(decideDataLakeProposalContract, {
  rateLimit: researchRateLimit('/api/v1/data-lakes/[id]/proposals/[proposal_id]'),
})
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req, res) => {
    const { id, proposal_id } = req.validatedParams;
    const ctx = await toMemberAccessContext(req);
    const result = await decideLakeProposal(req, id, proposal_id, ctx, () => req.validated, {
      requireObjectId: true,
    });
    return res.json({
      data: toPublicProposal(result.proposal),
      file: result.decision === 'approve' ? { id: result.fabFile.id, file_name: result.fabFile.fileName } : null,
    });
  });

export default handler;

export const config = {
  api: { externalResolver: true },
};
