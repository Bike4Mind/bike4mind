import { baseApi } from '@server/middlewares/baseApi';
import { usageEventRepository, creditTransactionRepository, userApiKeyRepository } from '@bike4mind/database';
import { CreditHolderType, type IOrgUsageDashboardResponse, type NamedApiKeyUsage } from '@bike4mind/common';
import { ForbiddenError } from '@server/utils/errors';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { resolveUserNames } from '@server/utils/resolveUserNames';
import { z } from 'zod';

const QuerySchema = z.object({
  organizationId: z.string().min(1),
  // Trailing window in days. Clamped so a stray value can't turn this into a
  // full-collection scan.
  days: z.coerce.number().int().min(1).max(365).optional(),
});

/**
 * Admin endpoint: one organization's AI spend over the trailing window, rolled
 * up by day (burn chart), member, model, feature, API key, and source.
 *
 * Owner-scoped to (ownerId=organizationId, ownerType=Organization), i.e. spend
 * billed to the org's credit pool - this reconciles with the org's currentCredits
 * and fills in as org-billed traffic lands. Reads UsageEventModel (not the
 * ledger) because it is the only source carrying per-member attribution (userId)
 * alongside frozen COGS + credits.
 *
 * Access: platform admins (cross-org) plus the org's own owner/manager, via
 * verifyOrgAccess - which pins non-admins to their org and 404s the rest.
 */
const handler = baseApi().get(async (req, res) => {
  if (!req.user) {
    throw new ForbiddenError('Authentication required');
  }

  const { organizationId, days = 30 } = QuerySchema.parse(req.query);
  await verifyOrgAccess(req.user, organizationId);

  // Usage cuts come from UsageEventModel (frozen COGS + per-member attribution);
  // by-API-key and by-source come from the ledger, the only source carrying
  // apiKeyId and source.
  const [summary, apiKeyUsage, sourceUsage, orgKeys] = await Promise.all([
    usageEventRepository.ownerUsageSummary(organizationId, CreditHolderType.Organization, days),
    creditTransactionRepository.apiKeyUsageForOwner(organizationId, CreditHolderType.Organization, days),
    creditTransactionRepository.sourceUsageForOwner(organizationId, CreditHolderType.Organization, days),
    userApiKeyRepository.findByOrganizationId(organizationId),
  ]);

  // Resolve member ids to display names; unresolved ids (deleted/cross-org users)
  // stay undefined so the client can label them rather than show a raw ObjectId.
  const nameById = await resolveUserNames(summary.byMember.map(m => m.userId));

  const keyById = new Map(orgKeys.map(k => [String(k.id), { keyName: k.name, keyPrefix: k.keyPrefix }]));
  const byApiKey: NamedApiKeyUsage[] = apiKeyUsage.map(u => ({ ...u, ...keyById.get(u.apiKeyId) }));

  const response: IOrgUsageDashboardResponse = {
    ...summary,
    organizationId,
    days,
    byMember: summary.byMember.map(m => ({ ...m, userName: nameById.get(m.userId) })),
    byApiKey,
    bySource: sourceUsage,
  };

  return res.json(response);
});

export default handler;
