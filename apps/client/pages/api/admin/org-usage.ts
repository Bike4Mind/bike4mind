import { baseApi } from '@server/middlewares/baseApi';
import { usageEventRepository, userRepository } from '@bike4mind/database';
import { CreditHolderType, type IOrgUsageDashboardResponse } from '@bike4mind/common';
import { ForbiddenError } from '@server/utils/errors';
import { z } from 'zod';

const QuerySchema = z.object({
  organizationId: z.string().min(1),
  // Trailing window in days. Clamped so a stray value can't turn this into a
  // full-collection scan.
  days: z.coerce.number().int().min(1).max(365).optional(),
});

/**
 * Admin endpoint: one organization's AI spend over the trailing window, rolled
 * up by day (burn chart), member, model, and feature.
 *
 * Owner-scoped to (ownerId=organizationId, ownerType=Organization), i.e. spend
 * billed to the org's credit pool - this reconciles with the org's currentCredits
 * and fills in as org-billed traffic lands. Reads UsageEventModel (not the
 * ledger) because it is the only source carrying per-member attribution (userId)
 * alongside frozen COGS + credits.
 */
const handler = baseApi().get(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const { organizationId, days = 30 } = QuerySchema.parse(req.query);

  const summary = await usageEventRepository.ownerUsageSummary(organizationId, CreditHolderType.Organization, days);

  // Resolve member ids to display names for the operator-facing table.
  const users = await userRepository.findByIds(summary.byMember.map(m => m.userId));
  const nameById = new Map(users.map(u => [String(u.id), u.name || u.username || u.email]));

  const response: IOrgUsageDashboardResponse = {
    organizationId,
    days,
    overTime: summary.overTime,
    byMember: summary.byMember.map(m => ({ ...m, userName: nameById.get(m.userId) ?? m.userId })),
    byModel: summary.byModel,
    byFeature: summary.byFeature,
    totals: summary.totals,
  };

  return res.json(response);
});

export default handler;
