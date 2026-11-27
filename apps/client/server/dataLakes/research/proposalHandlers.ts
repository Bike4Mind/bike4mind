import { dataLakeService } from '@bike4mind/services';
import {
  withTransaction,
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  dataLakeProposalRepository,
} from '@bike4mind/database';
import type { AccessContext, IDataLakeProposalDocument } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import type { Request } from 'express';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { admitProposedSource } from '@bike4mind/server-utils/dataLakes/proposalAdmissionDeps';
import { serializeLakeClaim } from '@bike4mind/server-utils/dataLakes/serializeLakeClaim';
import { lakeConfigAuditDb } from '@bike4mind/server-utils/dataLakes/lakeConfigAuditDb';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';

/*
 * The proposal decide body shared by the SPA route and the public v1 route. The input arrives as a
 * thunk so it is parsed where the SPA always parsed it.
 */

export type ProposalDecision = 'approve' | 'decline' | 'restore';

export type ProposalDecisionResult =
  | { decision: 'approve'; proposal: IDataLakeProposalDocument; fabFile: { id: string; fileName: string } }
  | { decision: 'decline' | 'restore'; proposal: IDataLakeProposalDocument };

export async function decideLakeProposal(
  req: Request,
  lakeId: string,
  proposalId: string,
  ctx: AccessContext,
  parseInput: () => { decision: ProposalDecision; reason?: string },
  // v1 only: a malformed id names no proposal, so it answers 404 after the lake gate rather than a CastError.
  { requireObjectId = false }: { requireObjectId?: boolean } = {}
): Promise<ProposalDecisionResult> {
  const { decision, reason } = parseInput();

  // The lake in the path is resolved (by id only, so a deleted lake's slug cannot land the review
  // on another lake) and read-gated first, so a stranger gets the usual not-found-style denial. The
  // service re-resolves the lake from the PROPOSAL and gates management on that, so the path id can
  // never widen authorization.
  const resolveLake = async () => {
    const lake = await dataLakeService.assertLakeAccessById(lakeId, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });

    const proposal =
      requireObjectId && !isValidObjectId(proposalId) ? null : await dataLakeProposalRepository.findById(proposalId);
    // Belongs-to check: reviewing through another lake's URL would let a caller who manages lake A
    // rule on lake B's queue, since the service authorizes against the proposal's own lake.
    if (!proposal || proposal.dataLakeId !== lake.id) throw new NotFoundError('Proposal not found');
    return lake;
  };

  const db = {
    dataLakeProposals: dataLakeProposalRepository,
    dataLakes: dataLakeRepository,
    dataLakeAccessGrants: dataLakeAccessGrantRepository,
    ...lakeConfigAuditDb,
  };
  // Attribute a key-driven review decision to the KEY, matching every other config-write route
  // (grants.ts, lifecycle.ts) - see lakeConfigAuditPrincipal for why a session write needs no override.
  const actor = { ...ctx, auditPrincipal: lakeConfigAuditPrincipal(req.user!, req.apiKeyInfo) };

  // Decline and restore run their gate and write inside one transaction so a grant revoke
  // committing mid-request collides on the lake doc and the retry re-reads live grants. Approve
  // serializes only its gate and claim; the source fetch runs after commit (see `serializeClaim`).
  if (decision === 'restore') {
    const proposal = await withTransaction(async () => {
      const lake = await resolveLake();
      const result = await dataLakeService.restoreDataLakeProposal(proposalId, actor, { db, logger: req.logger });
      // Serializes this write against a concurrent grant revoke - see WRITE-TIME RESIDUAL on `canManageLake`.
      await dataLakeRepository.touchIfStable(lake.id);
      return result;
    });
    return { decision, proposal };
  }

  if (decision === 'decline') {
    const proposal = await withTransaction(async () => {
      const lake = await resolveLake();
      const result = await dataLakeService.declineDataLakeProposal(
        proposalId,
        actor,
        { reason },
        { db, logger: req.logger }
      );
      await dataLakeRepository.touchIfStable(lake.id);
      return result;
    });
    return { decision, proposal };
  }

  const { proposal, fabFile } = await dataLakeService.approveDataLakeProposal(
    proposalId,
    actor,
    {
      db,
      admitSource: admitProposedSource,
      serializeClaim: claim =>
        serializeLakeClaim(async () => {
          await resolveLake();
          return claim();
        }),
      logger: req.logger,
    },
    { approverName: req.user?.name || req.user?.username || undefined }
  );
  return { decision, proposal, fabFile: { id: fabFile.id, fileName: fabFile.fileName } };
}
