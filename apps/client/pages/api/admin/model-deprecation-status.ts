import { baseApi } from '@client/server/middlewares/baseApi';
import { ForbiddenError } from '@bike4mind/utils';
import { getAvailableModels, getExpiringModels } from '@bike4mind/llm-adapters';

const handler = baseApi().get(async (req, res) => {
  if (!req.user!.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const daysAhead = parseInt(req.query.daysAhead as string) || 90;

  // Pass null to get the full model catalog (including deprecated) without API key filtering
  const fullCatalog = await getAvailableModels(null);

  const expiring = getExpiringModels(fullCatalog, daysAhead);

  res.json({
    daysAhead,
    totalModels: fullCatalog.length,
    expiringOrExpired: expiring,
  });
});

export default handler;
