import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeRepository } from '@bike4mind/database';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';
import { Request } from 'express';

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
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as { id: string };
    const reset = await dataLakeRepository.resetEmbeddingSpend(id);
    if (!reset) throw new NotFoundError('Data lake not found');

    req.logger?.log?.(`[spendGate] admin ${req.user.id} reset embeddingSpendMicroUsd for lake ${id}`);
    res.status(200).json({ ok: true });
  });

export default handler;
