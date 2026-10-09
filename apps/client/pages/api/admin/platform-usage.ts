import { baseApi } from '@server/middlewares/baseApi';
import { usageEventRepository, userApiKeyRepository } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import {
  ApiKeyScope,
  COMPLETION_SOURCES,
  CreditHolderType,
  type IPlatformUsageDashboardResponse,
  type NamedPlatformConsumerUsage,
} from '@bike4mind/common';
import { ForbiddenError } from '@server/utils/errors';
import { resolveApiKeyOwnerType } from '@server/utils/resolveApiKeyOwnerType';
import { resolveUserNames } from '@server/utils/resolveUserNames';
import { z } from 'zod';

/** Guards the id casts in the $in lookups below from a BSONError 500 (see resolveUserNames). */
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

const QuerySchema = z.object({
  // Trailing window in days, clamped so a stray value can't turn this into a
  // full-collection scan.
  days: z.coerce.number().int().min(1).max(365).optional(),
  // Optional filters, applied as the same kind of $match addition (not separate
  // query paths). Omit either to span all sources / all owner types.
  source: z.enum(COMPLETION_SOURCES).optional(),
  ownerType: z.enum([CreditHolderType.User, CreditHolderType.Organization]).optional(),
});

/**
 * GET /api/admin/platform-usage - platform-wide usage for the admin consumer
 * view: UsageEvent-derived (feature/COGS/credits/tokens), source- and
 * ownerType-filterable, with API-key consumers resolved to key/owner labels.
 * Endpoint/latency data is served by ./platform-usage/endpoints. Admin-only.
 *
 * requiredScopes gates the API-key path only: apiKeyAuth 403s an under-scoped key
 * before req.user is set, so a key issued for a narrow integration can't read
 * platform usage just because its owner is an admin. JWT/browser admins skip that
 * check and still pass the isAdmin gate below.
 */
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req, res) => {
  if (!req.user) {
    throw new ForbiddenError('Authentication required');
  }
  if (!req.user.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const { days = 30, source, ownerType } = QuerySchema.parse(req.query);

  const summary = await usageEventRepository.platformUsageSummary({ days, source, ownerType });

  // Resolve each consumer's apiKeyId -> key name/prefix + owner (user or org) name.
  const consumerKeyIds = [...new Set(summary.byConsumer.map(c => c.apiKeyId))].filter(id => OBJECT_ID_RE.test(id));
  const keys = consumerKeyIds.length ? await userApiKeyRepository.find({ _id: { $in: consumerKeyIds } }) : [];

  const keyById = new Map(
    keys.map(k => {
      // Org-billed keys attribute to the org pool; personal keys to the user.
      const billsOrg = resolveApiKeyOwnerType(k) === CreditHolderType.Organization;
      return [
        String(k.id),
        {
          keyName: k.name,
          keyPrefix: k.keyPrefix,
          ownerId: billsOrg ? (k.organizationId as string) : k.userId,
          ownerType: billsOrg ? CreditHolderType.Organization : CreditHolderType.User,
        },
      ] as const;
    })
  );

  const owners = [...keyById.values()];
  const userOwnerIds = owners.filter(o => o.ownerType === CreditHolderType.User).map(o => o.ownerId);
  const orgOwnerIds = [
    ...new Set(owners.filter(o => o.ownerType === CreditHolderType.Organization).map(o => o.ownerId)),
  ].filter(id => OBJECT_ID_RE.test(id));

  const [userNames, orgs] = await Promise.all([
    resolveUserNames(userOwnerIds),
    orgOwnerIds.length ? organizationRepository.find({ _id: { $in: orgOwnerIds } }) : Promise.resolve([]),
  ]);
  const orgNameById = new Map(orgs.map(o => [String(o.id), o.name]));

  const byConsumer: NamedPlatformConsumerUsage[] = summary.byConsumer.map(c => {
    const meta = keyById.get(c.apiKeyId);
    const ownerName = meta
      ? meta.ownerType === CreditHolderType.Organization
        ? orgNameById.get(meta.ownerId)
        : userNames.get(meta.ownerId)
      : undefined;
    return { ...c, ...meta, ownerName };
  });

  const response: IPlatformUsageDashboardResponse = {
    days,
    source,
    ownerType,
    overTime: summary.overTime,
    byFeature: summary.byFeature,
    byConsumer,
    byModel: summary.byModel,
    totals: summary.totals,
  };

  return res.json(response);
});

export default handler;
