import { canAccessAdmin } from '@bike4mind/common';
import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { spendReconciliationRepository } from '@bike4mind/database';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';

/**
 * Admin surface for provider spend reconciliation snapshots.
 *
 * GET ?view=latest  -> latest reconciliation per provider (banner data)
 * GET ?view=summary -> newest row per (month, provider)
 * GET ?view=history -> all snapshots, newest first (audit trail / drift)
 * GET (default)     -> latest per provider
 */
const api = adminApi({ adminPermissions: { GET: 'support:read' }, requiredScopes: [ApiKeyScope.ADMIN] });
const handler = api.get(async (req, res) => {
  if (!canAccessAdmin(req.user)) throw new ForbiddenError('Admin access required');

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
