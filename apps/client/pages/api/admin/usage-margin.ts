import { baseApi } from '@server/middlewares/baseApi';
import { usageEventRepository, userRepository } from '@bike4mind/database';
import { usdToCredits } from '@bike4mind/utils';
import { ApiKeyScope } from '@bike4mind/common';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';

const VIEWS = ['model-day', 'user', 'provider-month', 'settlement'] as const;
// A year of reconciliation history; keeps the dashboard's provider-month list finite.
const PROVIDER_MONTH_WINDOW = 12;
type MarginView = (typeof VIEWS)[number];

/**
 * Margin reporting over usage events.
 * GET ?view=model-day|user|provider-month|settlement&days=30
 *
 * Responses include targetCreditsPerUsd = usdToCredits(1): what current pricing
 * charges per $1 of COGS. Rows below it were charged under older pricing or
 * indicate a leak.
 *
 * requiredScopes gates the API-key path only: apiKeyAuth 403s an under-scoped key
 * before req.user is set, so a key issued for a narrow integration can't read
 * margin data just because its owner is an admin. JWT/browser admins skip that
 * check and still pass the isAdmin gate below.
 */
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const view = req.query.view as MarginView;
  if (!VIEWS.includes(view)) {
    throw new BadRequestError(`view must be one of: ${VIEWS.join(', ')}`);
  }

  const days = req.query.days ? Number(req.query.days) : 30;
  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    throw new BadRequestError('days must be between 1 and 365');
  }

  const targetCreditsPerUsd = usdToCredits(1);

  if (view === 'model-day') {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await usageEventRepository.marginByModelDay(since);
    return res.json({ targetCreditsPerUsd, rows });
  }

  if (view === 'user') {
    const rows = await usageEventRepository.marginByUser(days);
    // Operator-facing: resolve ids to names.
    const users = await userRepository.findByIds(rows.map(r => r.userId));
    const nameById = new Map(users.map(u => [String(u.id), u.name || u.username || u.email]));
    const named = rows.map(r => ({ ...r, userName: nameById.get(r.userId) ?? r.userId }));
    return res.json({ targetCreditsPerUsd, rows: named });
  }

  if (view === 'provider-month') {
    const rows = await usageEventRepository.monthlyCogsByProvider(PROVIDER_MONTH_WINDOW);
    return res.json({ targetCreditsPerUsd, rows });
  }

  if (view === 'settlement') {
    const rows = await usageEventRepository.settlementBreakdown(days);
    return res.json({ targetCreditsPerUsd, rows });
  }

  // Compile error if VIEWS grows without a matching branch above.
  const exhaustiveCheck: never = view;
  throw new BadRequestError(`view must be one of: ${VIEWS.join(', ')}, got ${exhaustiveCheck as string}`);
});

export default handler;
