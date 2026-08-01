import { baseApi } from '@server/middlewares/baseApi';
import { usageEventRepository, apiKeyUsageLogRepository, userApiKeyRepository } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import {
  COMPLETION_SOURCES,
  CreditHolderType,
  type IPlatformEndpointUsage,
  type IPlatformUsageDashboardResponse,
  type NamedPlatformConsumerUsage,
} from '@bike4mind/common';
import { ForbiddenError } from '@server/utils/errors';
import { resolveUserNames } from '@server/utils/resolveUserNames';
import { z } from 'zod';

/** Guards the id casts in the $in lookups below from a BSONError 500 (see resolveUserNames). */
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/** ApiKeyUsageLog's 90-day TTL: no endpoint data exists beyond this. */
const ENDPOINT_TTL_DAYS = 90;

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
 * view. Two intentionally distinct sections:
 *  - UsageEvent-derived (feature/COGS/credits/tokens), source- and
 *    ownerType-filterable, with API-key consumers resolved to key/owner labels.
 *  - ApiKeyUsageLog-derived endpoint/latency (request counts only, no credits).
 * Admin-only.
 */
const handler = baseApi().get(async (req, res) => {
  if (!req.user) {
    throw new ForbiddenError('Authentication required');
  }
  if (!req.user.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const { days = 30, source, ownerType } = QuerySchema.parse(req.query);

  // ApiKeyUsageLog logs only api/cli (API-key) traffic; a web/agent/system filter
  // has no endpoint data by construction, so skip that section rather than imply
  // it's empty for a real reason. Window is clamped to the collection's TTL.
  const endpointSourceApplies = !source || source === 'api' || source === 'cli';
  const endpointWindowDays = Math.min(days, ENDPOINT_TTL_DAYS);

  const [summary, endpoints] = await Promise.all([
    usageEventRepository.platformUsageSummary({ days, source, ownerType }),
    endpointSourceApplies
      ? apiKeyUsageLogRepository.platformEndpointUsage({ days: endpointWindowDays })
      : Promise.resolve<IPlatformEndpointUsage | null>(null),
  ]);

  // Resolve each consumer's apiKeyId -> key name/prefix + owner (user or org) name.
  const consumerKeyIds = [...new Set(summary.byConsumer.map(c => c.apiKeyId))].filter(id => OBJECT_ID_RE.test(id));
  const keys = consumerKeyIds.length ? await userApiKeyRepository.find({ _id: { $in: consumerKeyIds } }) : [];

  const keyById = new Map(
    keys.map(k => {
      // Org-billed keys attribute to the org pool; personal keys to the user.
      const billsOrg = k.billingOwnerType === CreditHolderType.Organization && !!k.organizationId;
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
    endpoints,
    endpointWindowDays,
  };

  return res.json(response);
});

export default handler;
