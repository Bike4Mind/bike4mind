import { dataLakeService } from '@bike4mind/services';
import { dataLakeAccessGrantRepository, dataLakeRepository } from '@bike4mind/database';
import type { AccessContext, IDataLakeDocument } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/utils';
import type { Request } from 'express';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';

/**
 * The gate every research route runs, factored out because there are three of them and a gate that
 * exists in three copies is a gate that will eventually differ in one.
 *
 * MANAGE-gated, exactly like the proposal queue it feeds (`proposals/index.ts`): configuring what a
 * run searches for, and spending money running it, are management rights. Read access to the lake
 * is not enough, and the read gate runs FIRST so a stranger still gets the not-found-style denial
 * that leaks no existence.
 *
 * Also hands back the `actor` these routes need to record a History event: building it here,
 * once, is what keeps every research route attributing a key-driven write to the key the same way
 * `grants.ts`/`lifecycle.ts` do, rather than re-deriving it three times.
 *
 * Returns the ACTIVE GRANTS alongside the gate's own verdict too, rather than making each
 * research-config/run write re-fetch them for its own audit call: `loadActiveLakeGrants` +
 * `canManageLake` here (not `resolveCanManageLake`, which fetches the same grants and discards
 * them) is the same reuse `reviewDataLakeProposal.ts`'s `resolveReviewable` applies - the gate and
 * the recorded manage rung must agree on the same grant set, or a curator/transferred-owner write
 * gets stamped `system`/`creator` in the History tab even though the grant is what authorized it.
 */
export async function assertLakeResearchManage(
  req: Request,
  lakeIdOrSlug: string,
  ctx: AccessContext
): Promise<{ lake: IDataLakeDocument; actor: dataLakeService.ManageActor; grants: dataLakeService.LakeGrant[] }> {
  const lake = await dataLakeService.assertLakeAccess(lakeIdOrSlug, ctx, {
    db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
  });
  const grants = await dataLakeService.loadActiveLakeGrants(lake, {
    db: { dataLakeAccessGrants: dataLakeAccessGrantRepository },
  });
  // 403 rather than 400, matching the sibling manage refusals (`spend.ts`, `proposals/index.ts`):
  // the read gate above already cleared the caller, so this is an authorization answer.
  if (!dataLakeService.canManageLake(lake, ctx, grants)) {
    throw new ForbiddenError('You do not have permission to manage research runs for this data lake');
  }

  const actor = { ...ctx, auditPrincipal: lakeConfigAuditPrincipal(req.user!, req.apiKeyInfo) };
  return { lake, actor, grants };
}
