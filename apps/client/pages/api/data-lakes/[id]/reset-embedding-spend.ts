import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_WRITE_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { dataLakeRepository, dataLakeSpendNotificationRepository, withTransaction } from '@bike4mind/database';
import { ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { Request } from 'express';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

/**
 * Admin-only: zero a lake's lifetime embedding-spend meter (embeddingSpendMicroUsd).
 *
 * The supported remedy for a poisoned meter. Reservations are released when a provider call
 * fails, but the release is best-effort (a hard crash between reserve and release leaks), the
 * estimate is deliberately ceil'd and never reconciled against the provider invoice, and the
 * budget levers are global - raising dataLakeEmbeddingBudgetPerLakeUsd to rescue ONE stuck
 * lake would raise the ceiling for every lake on the platform. This gives an operator the
 * narrow tool instead: one lake, back to zero, indexing resumes.
 *
 * Deliberately admin-only rather than lake-owner: the meter enforces a platform cost control,
 * and letting an owner zero their own spend would let them mint unlimited budget.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_WRITE_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as { id: string };
    await withTransaction(async () => {
      const lake = await dataLakeRepository.findById(id);
      if (!lake) throw new NotFoundError('Data lake not found');
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

export default handler;
