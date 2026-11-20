import { adminApi } from '@server/middlewares/adminApi';
import { DATA_LAKE_WRITE_SCOPES } from '@bike4mind/server-utils/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { isFullAdmin, type IDataLakeDocument } from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  dataLakeSpendNotificationRepository,
  organizationRepository,
  withTransaction,
} from '@bike4mind/database';
import { ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { Request } from 'express';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { toMemberAccessContext } from '@bike4mind/server-utils/dataLakes/toAccessContext';
import {
  assertDelegateCanCreditOrganization,
  assertDelegateCanCreditUser,
} from '@server/admin/creditGrants/delegateTargets';

/**
 * Admin (credits:adjust): zero a lake's lifetime embedding-spend meter (embeddingSpendMicroUsd).
 *
 * The supported remedy for a poisoned meter. Reservations are released when a provider call
 * fails, but the release is best-effort (a hard crash between reserve and release leaks), the
 * estimate is deliberately ceil'd and never reconciled against the provider invoice, and the
 * budget levers are global - raising dataLakeEmbeddingBudgetPerLakeUsd to rescue ONE stuck
 * lake would raise the ceiling for every lake on the platform. This gives an operator the
 * narrow tool instead: one lake, back to zero, indexing resumes.
 *
 * Deliberately an admin permission rather than lake-owner: the meter enforces a platform cost control,
 * and letting an owner zero their own spend would let them mint unlimited budget. For the same
 * reason a credits:adjust delegate cannot reset a lake they could manage without the admin role (owner,
 * curator, org admin or org grant), one they created, or one owned by an organization they belong to.
 */
const handler = adminApi({ requiredScopes: DATA_LAKE_WRITE_SCOPES, adminPermissions: { POST: 'credits:adjust' } })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    await withTransaction(async () => {
      const lake = await dataLakeRepository.findById(id);
      if (!lake) throw new NotFoundError('Data lake not found');
      await assertDelegateCanReset(req, lake);
      const reset = await dataLakeRepository.resetEmbeddingSpend(id);
      if (!reset) throw new NotFoundError('Data lake not found');

      await recordAdminActionFromRequest(req, {
        action: 'org.data_lake.embedding_spend_reset',
        target: { kind: 'settings', id: lake.id, displayName: `data lake ${lake.name}` },
        organizationId: lake.organizationId,
        summary: `reset embedding spend meter for data lake ${lake.name}`,
        changes: [{ field: 'embeddingSpendMicroUsd', before: lake.embeddingSpendMicroUsd ?? 0, after: 0 }],
        details: { lakeId: lake.id, ownerUserId: lake.createdByUserId },
      });
    });

    // Re-arm the lake-scope spend notice: it's keyed on the configured budget value (see
    // spendNotificationKeys.ts), which a reset doesn't change, so without this a zeroed lake
    // would never warn again.
    await dataLakeSpendNotificationRepository
      .deleteForLake(id, 'lake')
      .catch(err => req.logger?.warn?.(`[spendGate] failed to re-arm spend notice for lake ${id}: ${err}`));

    req.logger?.log?.(`[spendGate] admin ${req.user.id} reset embeddingSpendMicroUsd for lake ${id}`);
    res.status(200).json({ ok: true });
  });

const VERB = 'reset embedding spend for';

async function assertDelegateCanReset(
  req: Request,
  lake: Pick<IDataLakeDocument, 'id' | 'createdByUserId' | 'organizationId'>
): Promise<void> {
  const actor = req.user;
  if (isFullAdmin(actor)) return;
  const member = await toMemberAccessContext(req);
  const manages = await dataLakeService.resolveCanManageLake(lake, member, {
    db: { dataLakeAccessGrants: dataLakeAccessGrantRepository },
  });
  if (manages) throw new ForbiddenError(`You cannot ${VERB} a data lake you manage`);
  if (lake.createdByUserId) await assertDelegateCanCreditUser(actor, lake.createdByUserId, VERB);
  if (!lake.organizationId) return;
  const organization = await organizationRepository.findById(lake.organizationId);
  if (organization) await assertDelegateCanCreditOrganization(actor, organization, VERB);
}

export default handler;
