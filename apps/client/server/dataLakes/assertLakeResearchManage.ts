import { dataLakeService } from '@bike4mind/services';
import { dataLakeAccessGrantRepository, dataLakeRepository } from '@bike4mind/database';
import type { IDataLakeDocument } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/utils';
import type { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

/**
 * The gate every research route runs, factored out because there are three of them and a gate that
 * exists in three copies is a gate that will eventually differ in one.
 *
 * MANAGE-gated, exactly like the proposal queue it feeds (`proposals/index.ts`): configuring what a
 * run searches for, and spending money running it, are management rights. Read access to the lake
 * is not enough, and the read gate runs FIRST so a stranger still gets the not-found-style denial
 * that leaks no existence.
 */
export async function assertLakeResearchManage(req: Request, lakeIdOrSlug: string): Promise<IDataLakeDocument> {
  const ctx = await toAccessContext(req);

  const lake = await dataLakeService.assertLakeAccess(lakeIdOrSlug, ctx, {
    db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
  });
  const canManage = await dataLakeService.resolveCanManageLake(lake, ctx, {
    db: { dataLakeAccessGrants: dataLakeAccessGrantRepository },
  });
  // 403 rather than 400, matching the sibling manage refusals (`spend.ts`, `proposals/index.ts`):
  // the read gate above already cleared the caller, so this is an authorization answer.
  if (!canManage) {
    throw new ForbiddenError('You do not have permission to manage research runs for this data lake');
  }

  return lake;
}
