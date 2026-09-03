import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, dataLakeAccessGrantRepository, dataLakeProposalRepository } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/utils';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { admitProposedSource } from '@server/dataLakes/proposalAdmissionDeps';

const ReviewInput = z.object({
  decision: z.enum(['approve', 'decline']),
  /** Recorded on the tombstone so a later reviewer can see why this source was refused. */
  reason: z.string().trim().max(500).optional(),
});

/**
 * POST /api/data-lakes/:id/proposals/:proposalId - rule on one acquisition proposal (#1671).
 *
 * The only way content a producer found reaches a lake, and it is a human action by construction:
 * there is no auto-approval lever here or anywhere else (#1658 decision 10). Authorization,
 * writability, the once-only claim and the admission itself all live in the service; this route
 * resolves the actor, checks the proposal belongs to the lake in the path, and wires the ordinary
 * URL ingestion door as the admission adapter.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request, res) => {
    const { id, proposalId } = req.query as { id: string; proposalId: string };
    const { decision, reason } = ReviewInput.parse(req.body);
    const ctx = await toAccessContext(req);

    // The lake in the path is resolved and read-gated first so an id-or-slug still works and a
    // stranger gets the usual not-found-style denial. The service re-resolves the lake from the
    // PROPOSAL and gates management on that, so the path id can never widen authorization.
    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });

    const proposal = await dataLakeProposalRepository.findById(proposalId);
    // Belongs-to check: reviewing through another lake's URL would let a caller who manages lake A
    // rule on lake B's queue, since the service authorizes against the proposal's own lake.
    if (!proposal || proposal.dataLakeId !== lake.id) throw new NotFoundError('Proposal not found');

    const db = {
      dataLakeProposals: dataLakeProposalRepository,
      dataLakes: dataLakeRepository,
      dataLakeAccessGrants: dataLakeAccessGrantRepository,
    };

    if (decision === 'decline') {
      const declined = await dataLakeService.declineDataLakeProposal(proposalId, ctx, { reason }, { db });
      return res.json({ data: declined });
    }

    const { proposal: approved, fabFile } = await dataLakeService.approveDataLakeProposal(proposalId, ctx, {
      db,
      admitSource: admitProposedSource,
    });
    return res.json({ data: approved, fabFile: { id: fabFile.id, fileName: fabFile.fileName } });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
