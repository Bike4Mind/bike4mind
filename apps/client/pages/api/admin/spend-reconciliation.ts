import { baseApi } from '@server/middlewares/baseApi';
import { spendReconciliationRepository } from '@bike4mind/database';
import { ForbiddenError } from '@server/utils/errors';

/**
 * Admin surface for provider spend reconciliation snapshots.
 *
 * GET ?view=latest  -> latest reconciliation per provider (banner data)
 * GET ?view=summary -> newest row per (month, provider)
 * GET ?view=history -> all snapshots, newest first (audit trail / drift)
 * GET (default)     -> latest per provider
 */
const handler = baseApi().get(async (req, res) => {
  if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');

  const view = req.query.view as string | undefined;

  if (view === 'history') {
    const rows = await spendReconciliationRepository.fullHistory();
    return res.json({ reconciliations: rows });
  }

  if (view === 'summary') {
    const rows = await spendReconciliationRepository.newestPerMonthProvider();
    return res.json({ reconciliations: rows });
  }

  // Default: latest per provider (for the banner).
  const rows = await spendReconciliationRepository.latestByProvider();
  return res.json({ reconciliations: rows });
});

export default handler;
