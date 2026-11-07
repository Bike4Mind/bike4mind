import { Types } from 'mongoose';
import type { UserLimitEventKind, UserTimelineEntry } from '@bike4mind/common';
import { UserLimitEventModel } from '@bike4mind/database';
import type { TimelineWindow } from './userTimelineAccount';

const QUERY_MAX_TIME_MS = 15_000;

export type LimitEventRow = {
  _id: Types.ObjectId;
  kind: UserLimitEventKind;
  modelId: string;
  count: number;
  firstAt: Date;
  lastAt: Date;
  details?: Record<string, string | number | boolean | null>;
};

const LIMIT_SUMMARIES: Readonly<Record<UserLimitEventKind, string>> = {
  new_account_hourly_cap: 'Hit new-account hourly spend cap',
  new_account_daily_cap: 'Hit new-account daily spend cap',
  free_tier_daily_cap: 'Hit free-tier daily cap',
  model_requires_paid_plan: 'Refused a paid-plan model',
  insufficient_credits: 'Refused for insufficient credits',
  api_key_spend_cap: 'Hit API key spend cap',
  balance_debt: 'Balance went negative',
  debt_written_off: 'Shortfall written off',
};

const INSUFFICIENT_REASONS: Readonly<Record<string, string>> = {
  member_cap: 'org member cap',
  restricted_tier_token_cap: 'restricted-tier token cap',
};

const formatNumber = (value: unknown): string | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : undefined;

const labelled = (label: string, value: unknown, after = false): string | undefined => {
  const formatted = formatNumber(value);
  if (formatted === undefined) return undefined;
  return after ? `${formatted} ${label}` : `${label} ${formatted}`;
};

const usd = (label: string, value: unknown): string | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? `${label} $${value.toFixed(2)}` : undefined;

const kindDetail = (row: LimitEventRow): Array<string | undefined> => {
  const details = row.details ?? {};
  switch (row.kind) {
    case 'new_account_hourly_cap':
    case 'new_account_daily_cap':
    case 'free_tier_daily_cap':
      return [
        labelled('cap', details.capCredits),
        labelled('spent', details.spentCredits),
        usd('cost cap', details.capUsd),
        usd('cost', details.spentUsd),
        labelled('requested', details.requestedCredits),
      ];
    case 'insufficient_credits':
      return [
        typeof details.feature === 'string' ? details.feature : undefined,
        typeof details.reason === 'string' ? INSUFFICIENT_REASONS[details.reason] : undefined,
        labelled('needed', details.requiredCredits),
        labelled('had', details.availableCredits),
      ];
    case 'api_key_spend_cap':
      return [labelled('cap', details.spendCap), labelled('spent', details.currentSpend)];
    case 'balance_debt':
      return [labelled('shortfall', details.shortfall), labelled('balance after', details.balanceAfter)];
    case 'debt_written_off':
      return [labelled('written off', details.writtenOffCredits, true)];
    case 'model_requires_paid_plan':
      return [];
  }
};

/** The kind-specific numbers worth a glance, in plain words. */
export const limitDetail = (row: LimitEventRow): string | undefined =>
  [row.modelId || undefined, ...kindDetail(row)].filter(Boolean).join(' \u00b7 ') || undefined;

export const limitRowToEntry = (row: LimitEventRow): UserTimelineEntry => ({
  type: 'limit',
  id: row._id.toHexString(),
  at: row.lastAt,
  firstAt: row.firstAt,
  kind: row.kind,
  count: row.count,
  summary: `${LIMIT_SUMMARIES[row.kind]}${row.count > 1 ? ` \u00d7${row.count.toLocaleString('en-US')}` : ''}`,
  detail: limitDetail(row),
  alert: true,
});

/** Pages on (lastAt, _id): a row still collecting hits in the current hour moves up as it does. */
export const fetchLimitEntries = async (userId: string, limit: number, { cursor, range }: TimelineWindow) => {
  const rows = await UserLimitEventModel.find({
    $and: [
      { userId },
      ...(range.from ? [{ lastAt: { $gte: range.from } }] : []),
      ...(range.to ? [{ lastAt: { $lte: range.to } }] : []),
      ...(cursor
        ? [
            {
              $or: [
                { lastAt: { $lt: cursor.occurredAt } },
                { lastAt: cursor.occurredAt, _id: { $lt: new Types.ObjectId(cursor.id) } },
              ],
            },
          ]
        : []),
    ],
  })
    .sort({ lastAt: -1, _id: -1 })
    .limit(limit + 1)
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean<LimitEventRow[]>();
  return { entries: rows.slice(0, limit).map(limitRowToEntry), hasMore: rows.length > limit };
};
