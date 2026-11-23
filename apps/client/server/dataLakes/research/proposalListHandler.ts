import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, dataLakeAccessGrantRepository, dataLakeProposalRepository } from '@bike4mind/database';
import type {
  AccessContext,
  DataLakeProposalStatus,
  IDataLakeProposalDocument,
  LakeAccessSurface,
} from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/utils';
import type { Request } from 'express';
import { recordLakeRead } from '@server/dataLakes/recordLakeRead';

/*
 * The proposal-queue read shared by the SPA route and the public v1 route. Kept apart from the
 * decide handler so the read does not pull in the audit-write dependencies.
 */

export interface ProposalListInput {
  status?: DataLakeProposalStatus;
  limit: number;
  after?: { createdAt: Date; id: string };
  /** Rows actually returned to the caller when `limit` carries a look-ahead row; only those count as read. */
  servedLimit?: number;
}

export async function listLakeProposals(
  req: Request,
  lakeId: string,
  ctx: AccessContext,
  surface: LakeAccessSurface,
  parseInput: () => ProposalListInput
): Promise<IDataLakeProposalDocument[]> {
  const input = parseInput();

  const lake = await dataLakeService.assertLakeAccess(lakeId, ctx, {
    db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
  });
  const canManage = await dataLakeService.resolveCanManageLake(lake, ctx, {
    db: { dataLakeAccessGrants: dataLakeAccessGrantRepository },
  });
  // 403, not 400 - same manage-denial the sibling `spend.ts` refuses with, and the same status
  // `resolveReviewable` uses for the review routes. The read gate above already cleared the caller,
  // so this is an authorization answer.
  if (!canManage) {
    throw new ForbiddenError('You do not have permission to review proposals for this data lake');
  }

  const { servedLimit, ...window } = input;
  const proposals = await dataLakeProposalRepository.listByLake(lake.id, window);

  const served = servedLimit === undefined ? proposals : proposals.slice(0, servedLimit);
  if (served.length > 0) {
    const fileIds = served.flatMap(p => (p.admittedFabFileId ? [p.admittedFabFileId] : []));
    await recordLakeRead(req, { lakeIds: [lake.id], fileIds, surface });
  }
  return proposals;
}
