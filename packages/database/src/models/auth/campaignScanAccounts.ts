import { z } from 'zod';
import { User } from './UserModel';
import { UserApiKey } from './UserApiKeyModel';
import { UsageEvent } from '../billing/UsageEventModel';

/**
 * The raw per-account rows the account campaign sweep correlates (engine:
 * b4m-core/services/src/userService/accountCampaigns.ts). Reads stored signup data and the first
 * server-confirmed lifecycle steps only; no request bodies, prompts or client telemetry.
 */
export type CampaignScanRow = {
  userId: string;
  email: string;
  createdAt: Date;
  emailVerifiedAt: Date | null;
  ip: string | null;
  asn: number | null;
  isDatacenter: boolean | null;
  ja4: string | null;
  firstApiKeyAt: Date | null;
  firstUsageAt: Date | null;
};

export type CampaignScanQuery = { since: Date; until: Date; limit: number };

const querySchema: z.ZodType<CampaignScanQuery> = z
  .object({ since: z.date(), until: z.date(), limit: z.number().int().min(1).max(5_000) })
  .refine(
    query => query.since < query.until && query.until.getTime() - query.since.getTime() <= 14 * 24 * 60 * 60_000,
    'Window must be increasing and at most 14 days'
  );

const MAX_TIME_MS = 20_000;

type LeanScanUser = {
  _id: { toString(): string };
  email: string;
  createdAt: Date;
  emailVerifiedAt?: Date | null;
  signupMeta?: { ip?: string | null; asn?: number | null; isDatacenter?: boolean | null; ja4?: string | null } | null;
};

/**
 * Live accounts created in [since, until), newest first, capped at `limit`; `truncated` says the cap cut
 * older signups out of the scan. A step the account never ran is null; a read failure throws, so a
 * failed run is retried rather than recorded with steps missing.
 */
export async function loadCampaignScanAccounts(
  input: CampaignScanQuery
): Promise<{ rows: CampaignScanRow[]; truncated: boolean }> {
  const query = querySchema.parse(input);
  const users = await User.find(
    { createdAt: { $gte: query.since, $lt: query.until }, deletedAt: null },
    {
      email: 1,
      createdAt: 1,
      emailVerifiedAt: 1,
      'signupMeta.ip': 1,
      'signupMeta.asn': 1,
      'signupMeta.isDatacenter': 1,
      'signupMeta.ja4': 1,
    }
  )
    .sort({ createdAt: -1, _id: -1 })
    .limit(query.limit + 1)
    .maxTimeMS(MAX_TIME_MS)
    .lean<LeanScanUser[]>()
    .exec();
  const scanned = users.slice(0, query.limit);
  const userIds = scanned.map(user => user._id.toString());
  const [firstApiKeys, firstUsages] = await Promise.all([firstApiKeyAt(userIds), firstUsageAt(userIds, query.since)]);

  return {
    truncated: users.length > query.limit,
    rows: scanned.map(user => {
      const userId = user._id.toString();
      return {
        userId,
        email: user.email,
        createdAt: user.createdAt,
        emailVerifiedAt: user.emailVerifiedAt ?? null,
        ip: user.signupMeta?.ip ?? null,
        asn: user.signupMeta?.asn ?? null,
        isDatacenter: user.signupMeta?.isDatacenter ?? null,
        ja4: user.signupMeta?.ja4 ?? null,
        firstApiKeyAt: firstApiKeys.get(userId) ?? null,
        firstUsageAt: firstUsages.get(userId) ?? null,
      };
    }),
  };
}

type FirstAtRow = { _id: string; first: Date };

// aggregate skips the soft-delete filter, so a key revoked since still counts as created.
async function firstApiKeyAt(userIds: string[]): Promise<Map<string, Date>> {
  if (userIds.length === 0) return new Map();
  const rows = await UserApiKey.aggregate<FirstAtRow>([
    { $match: { userId: { $in: userIds } } },
    { $group: { _id: '$userId', first: { $min: '$createdAt' } } },
  ]).option({ maxTimeMS: MAX_TIME_MS });
  return new Map(rows.map(row => [String(row._id), row.first]));
}

async function firstUsageAt(userIds: string[], since: Date): Promise<Map<string, Date>> {
  if (userIds.length === 0) return new Map();
  const rows = await UsageEvent.aggregate<FirstAtRow>([
    { $match: { userId: { $in: userIds }, createdAt: { $gte: since } } },
    { $group: { _id: '$userId', first: { $min: '$createdAt' } } },
  ]).option({ maxTimeMS: MAX_TIME_MS });
  return new Map(rows.map(row => [String(row._id), row.first]));
}
