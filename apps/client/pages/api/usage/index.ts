import { baseApi } from '@server/middlewares/baseApi';
import { usageEventRepository, creditTransactionRepository, userApiKeyRepository } from '@bike4mind/database';
import {
  ApiKeyScope,
  CreditHolderType,
  hasAdminPermission,
  type IUsageDashboardResponse,
  type NamedApiKeyUsage,
  type UsageOwnerType,
} from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { verifyOrgOwner } from '@bike4mind/server-utils/utils/orgAccess';
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
 * Access: platform admins see any owner. A delegate holding support:read (API keys
 * need ApiKeyScope.ADMIN) gets the same read-only view minus key names/prefixes.
 * Otherwise an Organization owner is gated by verifyOrgOwner (org managers are
 * refused); a User owner may read only their own id.
 */
const handler = baseApi().get(async (req, res) => {
  if (!req.user) {
    throw new ForbiddenError('Authentication required');
  }

  const { ownerType, ownerId, days = 30 } = QuerySchema.parse(req.query);

  const canReadSupport =
    hasAdminPermission(req.user, 'support:read') &&
    (!req.apiKeyInfo || req.apiKeyInfo.scopes.includes(ApiKeyScope.ADMIN));

  let viaDelegate = false;
  if (ownerType === CreditHolderType.Organization) {
    // A support:read delegate is checked as platform admin: read-only access to any org, minus key names.
    const org = await verifyOrgOwner({ id: req.user.id, isAdmin: req.user.isAdmin || canReadSupport }, ownerId);
    viaDelegate = !req.user.isAdmin && org.userId !== req.user.id;
  } else if (req.user.id !== ownerId && !req.user.isAdmin) {
    if (!canReadSupport) throw new ForbiddenError('You can only view your own usage');
    viaDelegate = true;
  }
  const showKeyIdentifiers = !viaDelegate;

  // Usage cuts come from UsageEventModel (frozen COGS + per-member attribution);
  // by-API-key and by-source come from the ledger, the only source carrying
  // apiKeyId and source.
  //
  // findByOrganizationId's other consumer is the org key-management list
  // (userApiKeyService/list.ts); both rely on it returning only Organization-billed
  // keys, which findByOrganizationId guarantees through its own billingOwnerType
  // conjunct - not through the create-time invariant alone, which a script or direct
  // DB write can bypass (see UserApiKeyModel.ts and its embed test).
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

  const keyById = new Map(
    (showKeyIdentifiers ? ownerKeys : []).map(k => [String(k.id), { keyName: k.name, keyPrefix: k.keyPrefix }])
  );
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
