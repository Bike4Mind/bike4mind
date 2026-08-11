/**
 * Builds the User Activity aggregation for GET /api/users/counterLogs.
 *
 * The pipeline emits one flat row per (day, counter, user, split metadata) and pages it
 * server-side. The previous shape re-grouped rows into a nested `users[]` array and returned
 * every match unpaginated, which reached ~17MB on production data and tripped Lambda's 6MB
 * response cap (413 -> 502).
 *
 * Everything up to the facet is the expensive part (~8-9s on a 7-day production window), and it
 * costs the same whether the facet returns 25 rows or 25,000. The route therefore asks for a
 * whole window of rows and slices pages out of it - see userActivityCache.ts.
 *
 * ROW UNIT: one row per day/counter/user, split further only by SPLIT_METADATA_KEYS. The
 * remaining metadata is per-event identity, so keeping the whole subdocument in the group key
 * made almost every raw event its own row.
 *
 * Every filter that decides which rows are visible must be applied here, not in the browser:
 * with server-side paging, a client-side filter would only ever filter the current page.
 */
// any: aggregation stages are arbitrary BSON documents handed straight to model.aggregate();
// the repo's pipeline builders keep this boundary loose (see db-core/documentdb-compat).
/* eslint-disable @typescript-eslint/no-explicit-any */

import { z } from 'zod';
import { SAFE_USER_LOOKUP_PROJECT, dayjs } from '@bike4mind/common';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';

export const DEFAULT_PAGE_SIZE = 25;
/** Keeps one page comfortably under Lambda's 6MB response cap even for wide metadata. */
export const MAX_PAGE_SIZE = 5000;

/**
 * Metadata paths are interpolated into Mongo field keys, so they are allowlisted rather
 * than escaped: letters-first segments only, which rules out `$`-prefixed operators and
 * `__proto__`.
 */
const METADATA_FIELD = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*){0,4}$/;

/**
 * The only metadata keys that split the row unit. A key belongs here when two rows differing
 * on it read as two different activities; everything else (sessionId, requestId, token counts,
 * durations) is per-event identity and would fragment the output back to one row per event.
 *
 * `reportId` reproduces the pre-pagination client's key, which split report views per report.
 * Widening this list is a product decision, not a mechanical one: adding `source` or
 * `modelName` would split rows the client used to merge.
 */
export const SPLIT_METADATA_KEYS = ['reportId'] as const;

const MetadataFilterSchema = z.object({
  field: z.string().max(64).regex(METADATA_FIELD),
  operator: z.enum(['equals', 'contains', 'in', 'exists', 'not_exists']),
  // Scalars only. `unknown` let a crafted object reach String(value) and throw (an object with
  // non-callable toString/valueOf has no primitive), which surfaced as a 500 rather than a 400.
  value: z.union([z.string().max(200), z.number(), z.boolean()]).optional(),
});

export type MetadataFilter = z.infer<typeof MetadataFilterSchema>;

/** Parses the JSON-encoded `metadataFilters` query param. Throws ZodError on anything unsafe. */
export function parseMetadataFilters(raw: string | undefined): MetadataFilter[] {
  if (!raw) return [];
  return z.array(MetadataFilterSchema).max(10).parse(JSON.parse(raw));
}

export interface UserActivityQueryParams {
  startDate: string;
  endDate: string;
  /**
   * IANA zone that startDate/endDate name a calendar day in, and that the day buckets are cut in.
   * One value drives both, or the first and last buckets are partial days. Defaults to UTC.
   */
  timezone?: string;
  /** Rows to skip before the returned window. The caller pages by moving this, not by re-sorting. */
  skip: number;
  /** Rows to return. Sized by the caller: one page for a deep page, a whole cache window otherwise. */
  limit: number;
  events?: string[];
  orgs?: string[];
  excludeOrgs?: string[];
  counterName?: string;
  userEmail?: string;
  metadataFilters?: MetadataFilter[];
  usersCollection?: string;
}

/**
 * Escapes a value for use as a regex, dropping control characters first: BSON rejects a pattern
 * containing NUL, and that driver error escapes the ZodError branch as a 500 rather than a 400.
 * A codepoint filter rather than a character class, to stay clear of no-control-regex.
 */
const regexSource = (value: unknown) =>
  escapeRegex(
    Array.from(String(value ?? ''))
      .filter(ch => {
        const code = ch.codePointAt(0)!;
        return code > 0x1f && code !== 0x7f;
      })
      .join('')
  );

/** Widens a filter value so a numeric/boolean metadata field still matches its string form. */
function coerceValues(value: unknown): unknown[] {
  const asString = String(value ?? '');
  const values: unknown[] = [asString];
  if (asString.trim() !== '' && !Number.isNaN(Number(asString))) values.push(Number(asString));
  if (asString === 'true') values.push(true);
  if (asString === 'false') values.push(false);
  return values;
}

function metadataCondition({ field, operator, value }: MetadataFilter): Record<string, unknown> {
  const path = `metadata.${field}`;

  switch (operator) {
    case 'exists':
      return { [path]: { $exists: true, $ne: null } };
    case 'not_exists':
      return { $or: [{ [path]: { $exists: false } }, { [path]: null }] };
    case 'contains':
      return { [path]: { $regex: regexSource(value), $options: 'i' } };
    case 'in':
      return {
        [path]: {
          $in: String(value ?? '')
            .split(',')
            .map(v => v.trim())
            .filter(Boolean)
            .map(v => new RegExp(`^${regexSource(v)}$`, 'i')),
        },
      };
    case 'equals':
    default:
      return { [path]: { $in: coerceValues(value) } };
  }
}

export interface UserActivityPipeline {
  pipeline: any[];
  facetStages: Record<string, any[]>;
}

export function buildUserActivityPipeline({
  startDate,
  endDate,
  timezone = 'UTC',
  skip,
  limit,
  events,
  orgs,
  excludeOrgs,
  counterName,
  userEmail,
  metadataFilters = [],
  usersCollection = 'users',
}: UserActivityQueryParams): UserActivityPipeline {
  // startDate/endDate name calendar days in `timezone`, so their local midnight and end-of-day
  // resolve to instants in that zone rather than being pinned to UTC. The same zone cuts the day
  // buckets below, so the window and the buckets line up.
  const matchCondition: any = {
    datetime: {
      $gte: dayjs.tz(`${startDate}T00:00:00.000`, timezone).toDate(),
      $lte: dayjs.tz(`${endDate}T23:59:59.999`, timezone).toDate(),
    },
  };

  const counterNameCondition = {
    ...(events?.length ? { $in: events } : {}),
    ...(counterName ? { $regex: escapeRegex(counterName), $options: 'i' } : {}),
  };
  if (Object.keys(counterNameCondition).length) {
    matchCondition.counterName = counterNameCondition;
  }

  // Both constrain userOrganization, so they merge into one operator. Assigning twice dropped the
  // $in whenever both were sent - invisible from the UI, which only offers the exclusion
  // checkboxes while "All Organizations" is selected, but an API caller can send both.
  const orgFilter: Record<string, string[]> = {};
  if (orgs?.length && !orgs.includes('all')) {
    orgFilter.$in = orgs;
  }
  if (excludeOrgs?.length) {
    orgFilter.$nin = excludeOrgs;
  }
  if (Object.keys(orgFilter).length) {
    matchCondition.userOrganization = orgFilter;
  }

  if (metadataFilters.length) {
    matchCondition.$and = metadataFilters.map(metadataCondition);
  }

  const pipeline: any[] = [
    { $match: matchCondition },
    { $addFields: { dateString: { $dateToString: { format: '%Y-%m-%d', date: '$datetime', timezone } } } },
    {
      // Group BEFORE the join: userEmail/userOrganization are functionally determined by userId,
      // so joining once per grouped row instead of once per raw document is ~2x faster on a
      // 7-day production window. Preserved from the M1 reorder.
      $group: {
        _id: {
          date: '$dateString',
          counterName: '$counterName',
          userId: '$userId',
          // $ifNull normalises a missing key to null, so "absent" and "explicitly null" do not
          // become two group keys for what the reader sees as the same row.
          metadataKey: Object.fromEntries(
            SPLIT_METADATA_KEYS.map(key => [key, { $ifNull: [`$metadata.${key}`, null] }])
          ),
        },
        totalValue: { $sum: '$counterValue' },
        count: { $sum: 1 },
        // A sample, not a summary: the row now spans events whose non-split metadata differs,
        // and the grid renders this subdocument as an example of what the group contains.
        metadata: { $first: '$metadata' },
        // The counter log's own denormalised org, which is also what the org filters match on.
        // The User document carries no organization field, so joining for it yields undefined.
        userOrganization: { $first: '$userOrganization' },
      },
    },
    {
      // $convert (not $toObjectId) so a non-ObjectId userId such as 'SYSTEM' yields null and
      // simply fails to join, instead of aborting the whole aggregation with a 500.
      $addFields: { userObjectId: { $convert: { input: '$_id.userId', to: 'objectId', onError: null } } },
    },
    {
      // Aggregation $lookup bypasses Mongoose select:false, so project off the shared
      // secret-free baseline plus the one extra non-secret field this route reads (email).
      // Never add credential/secret fields here.
      $lookup: {
        from: usersCollection,
        localField: 'userObjectId',
        foreignField: '_id',
        pipeline: [{ $project: { ...SAFE_USER_LOOKUP_PROJECT, email: 1 } }],
        as: 'user',
      },
    },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
    { $addFields: { userEmail: { $ifNull: ['$user.email', ''] } } },
    // The email lives on the joined user, so this can only be matched after the join.
    ...(userEmail ? [{ $match: { userEmail: { $regex: escapeRegex(userEmail), $options: 'i' } } }] : []),
    // Sort before the facet: a $sort inside a $facet sub-pipeline is held to the 100MB
    // in-memory limit. The tiebreak has to be TOTAL or a row can straddle or skip a window
    // across the two facet executions - userEmail cannot do it, since every row whose join
    // missed shares the same '' fallback. Covering the whole group key (userId + metadataKey,
    // ordered by BSON comparison) makes the order unique, because the key is unique per row.
    // Every field added to the group key has to be added here too.
    {
      $sort: {
        '_id.date': -1,
        count: -1,
        '_id.counterName': 1,
        userEmail: 1,
        '_id.userId': 1,
        '_id.metadataKey': 1,
      },
    },
  ];

  const facetStages: Record<string, any[]> = {
    rows: [
      { $skip: skip },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          date: '$_id.date',
          counterName: '$_id.counterName',
          userId: '$_id.userId',
          userEmail: 1,
          userOrganization: 1,
          metadata: 1,
          count: 1,
          totalValue: 1,
        },
      },
    ],
    total: [{ $count: 'value' }],
  };

  return { pipeline, facetStages };
}
