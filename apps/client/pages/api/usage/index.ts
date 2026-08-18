import { baseApi } from '@server/middlewares/baseApi';
import { usageEventRepository, creditTransactionRepository, userApiKeyRepository } from '@bike4mind/database';
import {
  CreditHolderType,
  type IUsageDashboardResponse,
  type NamedApiKeyUsage,
  type UsageOwnerType,
} from '@bike4mind/common';
import { ForbiddenError } from '@server/utils/errors';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { resolveUserNames } from '@server/utils/resolveUserNames';
import { z } from 'zod';

const QuerySchema = z.object({
  ownerType: z
    .nativeEnum(CreditHolderType)
    .refine((t): t is UsageOwnerType => t === CreditHolderType.User || t === CreditHolderType.Organization, {
      message: 'ownerType must be User or Organization',
    }),
  ownerId: z.string().min(1),
  // Trailing window in days. Clamped so a stray value can't turn this into a
  // full-collection scan.
  days: z.coerce.number().int().min(1).max(365).optional(),
});

/**
 * One owner's AI spend over the trailing window, rolled up by day (burn chart),
 * member, model, feature, API key, and source. Serves both personal (User) and
 * organization owners through a single code path - only the access-control
 * branch and the API-key name lookup differ by owner type.
 *
 * Owner-scoped to (ownerId, ownerType), i.e. spend billed to that owner's credit
 * pool. Personal keys billed to an org land under the org (ownerType=Organization)
 * and surface in the org's own dashboard, not here - the User view intentionally
 * shows only user-billed spend. Reads UsageEventModel (not the ledger) for the
 * member/model/feature cuts because it is the only source carrying frozen COGS +
 * per-member attribution.
 *
 * Access: platform admins see any owner. Otherwise an Organization owner is gated
 * by verifyOrgAccess (owner/manager only); a User owner may read only their own id.
 */
const handler = baseApi().get(async (req, res) => {
  if (!req.user) {
    throw new ForbiddenError('Authentication required');
  }

  const { ownerType, ownerId, days = 30 } = QuerySchema.parse(req.query);

  if (ownerType === CreditHolderType.Organization) {
    await verifyOrgAccess(req.user, ownerId);
  } else if (!req.user.isAdmin && req.user.id !== ownerId) {
    throw new ForbiddenError('You can only view your own usage');
  }

  // Usage cuts come from UsageEventModel (frozen COGS + per-member attribution);
  // by-API-key and by-source come from the ledger, the only source carrying
  // apiKeyId and source.
  const [summary, apiKeyUsage, sourceUsage, ownerKeys] = await Promise.all([
    usageEventRepository.ownerUsageSummary(ownerId, ownerType, days),
    creditTransactionRepository.apiKeyUsageForOwner(ownerId, ownerType, days),
    creditTransactionRepository.sourceUsageForOwner(ownerId, ownerType, days),
    ownerType === CreditHolderType.Organization
      ? userApiKeyRepository.findByOrganizationId(ownerId)
      : userApiKeyRepository.findByUserId(ownerId),
  ]);

  // Resolve member ids to display names; unresolved ids (deleted/cross-org users)
  // stay undefined so the client can label them rather than show a raw ObjectId.
  // Only Organizations render the by-member cut - a User owner's single self-row is
  // never shown, so skip the lookup entirely.
  const nameById =
    ownerType === CreditHolderType.Organization
      ? await resolveUserNames(summary.byMember.map(m => m.userId))
      : new Map<string, string>();

  const keyById = new Map(ownerKeys.map(k => [String(k.id), { keyName: k.name, keyPrefix: k.keyPrefix }]));
  const byApiKey: NamedApiKeyUsage[] = apiKeyUsage.map(u => ({ ...u, ...keyById.get(u.apiKeyId) }));

  const response: IUsageDashboardResponse = {
    ...summary,
    ownerId,
    ownerType,
    days,
    byMember: summary.byMember.map(m => ({ ...m, userName: nameById.get(m.userId) })),
    byApiKey,
    bySource: sourceUsage,
  };

  return res.json(response);
});

export default handler;
