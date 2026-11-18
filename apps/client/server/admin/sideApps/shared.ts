import type { PipelineStage } from 'mongoose';
import { AI_USAGE_TRANSACTION_TYPES, CreditHolderType } from '@bike4mind/common';
import { CreditTransaction, UserApiKey } from '@bike4mind/database';
import { classifySideAppRefusal } from '@bike4mind/server-utils/auth/sideAppRefusal';
import {
  classifyAgentExecutionOutcome,
  classifyQuestOutcome,
  classifyRequestOutcome,
  failureRate,
  type OutcomeCounts,
  type SideAppOutcome,
  type StatusClass,
} from '@bike4mind/server-utils/sideApps/outcomes';
import {
  SIDE_APP_REQUEST_TIERS,
  SIDE_APP_TIER_BUCKETS,
  type SideAppOutcomeSummary,
  type SideAppRefusalSummary,
  type SideAppRequestTier,
  type SideAppTierBucket,
  type SideAppTierCredits,
  type SideAppTierRequests,
} from '../../../shared/sideApps';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_TIME_MS = 20_000;
/** ApiKeyUsageLog and SideAppRefusal both expire rows after this many days. */
export const REQUEST_RETENTION_DAYS = 90;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export interface SideAppWindows {
  spendDays: number;
  requestDays: number;
  spendFrom: Date;
  requestFrom: Date;
  /** Start of the span in which unstamped ledger rows are attributed through their key. */
  legacyFrom: Date;
}

export function resolveWindows(days: number, now: Date): SideAppWindows {
  const spendDays = Math.min(365, Math.max(1, Math.trunc(days)));
  const requestDays = Math.min(spendDays, REQUEST_RETENTION_DAYS);
  const spendFrom = new Date(now.getTime() - spendDays * DAY_MS);
  return {
    spendDays,
    requestDays,
    spendFrom,
    requestFrom: new Date(now.getTime() - requestDays * DAY_MS),
    legacyFrom: new Date(Math.max(spendFrom.getTime(), now.getTime() - REQUEST_RETENTION_DAYS * DAY_MS)),
  };
}

export const emptyTierCredits = (): SideAppTierCredits =>
  Object.fromEntries(SIDE_APP_TIER_BUCKETS.map(bucket => [bucket, 0])) as SideAppTierCredits;
export const emptyTierRequests = (): SideAppTierRequests =>
  Object.fromEntries(SIDE_APP_REQUEST_TIERS.map(tier => [tier, 0])) as SideAppTierRequests;

export const requestTierOf = (standing: unknown): SideAppRequestTier =>
  standing === 'paid' || standing === 'unpaid' ? standing : 'unrecorded';

export const tierBucketExpression = {
  $switch: {
    branches: [
      { case: { $eq: ['$ownerType', 'Organization'] }, then: 'org' },
      { case: { $eq: ['$payerStanding', 'paid'] }, then: 'paid' },
      { case: { $eq: ['$payerStanding', 'unpaid'] }, then: 'unpaid' },
    ],
    default: 'unrecorded',
  },
};

/** Mirrors statusClassOf in server-utils, evaluated inside the pipeline. */
export const statusClassExpression = {
  $switch: {
    branches: [
      { case: { $eq: ['$statusCode', 202] }, then: 'accepted' },
      { case: { $and: [{ $gte: ['$statusCode', 200] }, { $lt: ['$statusCode', 300] }] }, then: '2xx' },
      { case: { $and: [{ $gte: ['$statusCode', 500] }, { $lt: ['$statusCode', 600] }] }, then: '5xx' },
    ],
    default: 'other',
  },
};

const dayExpression = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } };

/** Ledger rows that are charges for AI work; grants, refunds and transfers are never spend. */
export const chargeMatch = (from: Date) => ({
  type: { $in: [...AI_USAGE_TRANSACTION_TYPES] },
  credits: { $lt: 0 },
  createdAt: { $gte: from },
});

export interface SpendCell {
  key: string;
  bucket: SideAppTierBucket;
  day: string;
  credits: number;
}
export interface SpendUser {
  key: string;
  userId: string;
  credits: number;
}

/** Spend by (key, tier, day) plus by (key, paying user), over rows already narrowed by `match`. */
export async function aggregateSpend(
  match: Record<string, unknown>,
  keyField: 'oauthClientId' | 'apiKeyId'
): Promise<{ cells: SpendCell[]; users: SpendUser[] }> {
  const run = (stages: PipelineStage[]) =>
    CreditTransaction.aggregate<{ _id: Record<string, string>; credits: number }>([
      { $match: match },
      ...stages,
    ]).option({
      maxTimeMS: MAX_TIME_MS,
    });
  const [cellRows, userRows] = await Promise.all([
    run([
      {
        $group: {
          _id: { key: `$${keyField}`, bucket: tierBucketExpression, day: dayExpression },
          credits: { $sum: { $abs: '$credits' } },
        },
      },
    ]),
    run([
      { $match: { ownerType: 'User' } },
      { $group: { _id: { key: `$${keyField}`, userId: '$ownerId' }, credits: { $sum: { $abs: '$credits' } } } },
    ]),
  ]);
  return {
    cells: cellRows.map(row => ({
      key: String(row._id.key),
      bucket: row._id.bucket as SideAppTierBucket,
      day: row._id.day,
      credits: row.credits,
    })),
    users: userRows.map(row => ({ key: String(row._id.key), userId: String(row._id.userId), credits: row.credits })),
  };
}

/**
 * Charge rows written before the app was stamped, which only their paying key can attribute. The
 * ownerType clause is always true (the field is required) and lets the { ownerType, createdAt, type }
 * index serve the read; `apiKeyIds` narrows to specific keys.
 */
export const unstampedKeyMatch = (legacyFrom: Date, apiKeyIds?: string[]) => ({
  oauthClientId: { $exists: false },
  apiKeyId: apiKeyIds ? { $in: apiKeyIds } : { $exists: true, $ne: null },
  ownerType: { $in: Object.values(CreditHolderType) },
  ...chargeMatch(legacyFrom),
});

/**
 * Maps the exchange keys behind unstamped ledger rows to their app with one batched key read. Ids are
 * compared as strings: the ledger stores the key id as a string and the key model as an ObjectId.
 */
export async function resolveUnstampedExchangeKeys(legacyFrom: Date): Promise<Map<string, string>> {
  const distinct = await CreditTransaction.distinct('apiKeyId', unstampedKeyMatch(legacyFrom)).maxTimeMS(MAX_TIME_MS);
  const ids = (distinct as unknown[]).map(String).filter(id => OBJECT_ID_RE.test(id));
  if (ids.length === 0) return new Map();
  const keys = await UserApiKey.find({ _id: { $in: ids }, 'metadata.createdFrom': 'oauth-exchange' })
    .select('metadata.oauthClientId')
    .lean<Array<{ _id: unknown; metadata?: { oauthClientId?: string } }>>();
  const map = new Map<string, string>();
  for (const key of keys) {
    const clientId = key.metadata?.oauthClientId;
    if (clientId) map.set(String(key._id), clientId);
  }
  return map;
}

export async function findAttributionStartedAt(): Promise<string | null> {
  const first = await CreditTransaction.findOne({ oauthClientId: { $exists: true } })
    .sort({ createdAt: 1 })
    .select('createdAt')
    .maxTimeMS(MAX_TIME_MS)
    .lean<{ createdAt?: Date } | null>();
  return first?.createdAt ? new Date(first.createdAt).toISOString() : null;
}

export interface FoldedRequest {
  endpoint: string;
  tier: SideAppRequestTier;
  count: number;
  outcome: SideAppOutcome | null;
}

/** One grouped usage-log row, classified with the shared outcome definition. */
export function foldRequestRow(row: {
  endpoint: string;
  standing?: unknown;
  completionOutcome?: string | null;
  statusClass: StatusClass;
  count: number;
}): FoldedRequest {
  return {
    endpoint: row.endpoint,
    tier: requestTierOf(row.standing),
    count: row.count,
    outcome: classifyRequestOutcome({
      endpoint: row.endpoint,
      statusClass: row.statusClass,
      completionOutcome: row.completionOutcome as Parameters<typeof classifyRequestOutcome>[0]['completionOutcome'],
    }),
  };
}

export function addOutcome(counts: OutcomeCounts, outcome: SideAppOutcome | null, n: number): void {
  if (outcome) counts[outcome] += n;
}

export const summarizeOutcomes = (counts: OutcomeCounts): SideAppOutcomeSummary => ({
  ...counts,
  failureRate: failureRate(counts),
});

export const questOutcomeOf = (row: {
  status?: string | null;
  type?: string | null;
  errorCode?: string | null;
  finishReason?: string | null;
}) => classifyQuestOutcome(row);

export const agentOutcomeOf = (status: string | null | undefined) => classifyAgentExecutionOutcome(status);

export const emptyRefusals = (): SideAppRefusalSummary => ({
  total: 0,
  byClass: { policy: 0, app_fault: 0, our_fault: 0 },
  byReason: [],
});

export function addRefusal(summary: SideAppRefusalSummary, reason: string, count: number): void {
  const refusalClass = classifySideAppRefusal(reason);
  summary.total += count;
  summary.byClass[refusalClass] += count;
  const existing = summary.byReason.find(entry => entry.reason === reason);
  if (existing) existing.count += count;
  else summary.byReason.push({ reason, class: refusalClass, count });
}

export function sortRefusalReasons(summary: SideAppRefusalSummary): SideAppRefusalSummary {
  summary.byReason.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return summary;
}
