/**
 * Builds the User Activity aggregation for GET /api/users/counterLogs.
 *
 * The pipeline emits one flat row per (day, counter, user, metadata) and pages it
 * server-side. The previous shape re-grouped rows into a nested `users[]` array and returned
 * every match unpaginated, which reached ~17MB on production data and tripped Lambda's 6MB
 * response cap (413 -> 502).
 *
 * Everything up to the facet is the expensive part (~8-9s on a 7-day production window), and it
 * costs the same whether the facet returns 25 rows or 25,000. The route therefore asks for a
 * whole window of rows and slices pages out of it - see userActivityCache.ts.
 *
 * ROW UNIT: `metadata` is part of the group key, so two events that differ only in metadata
 * stay separate rows. The pre-pagination client merged them (per day/counter/user), so the
 * grid shows more, finer rows than it used to and `total` counts those finer rows. That is a
 * deliberate interim state - defragmenting the group key is tracked separately, and has to
 * come with a decision about which metadata keys are worth splitting on.
 *
 * Every filter that decides which rows are visible must be applied here, not in the browser:
 * with server-side paging, a client-side filter would only ever filter the current page.
 */
// any: aggregation stages are arbitrary BSON documents handed straight to model.aggregate();
// the repo's pipeline builders keep this boundary loose (see db-core/documentdb-compat).
/* eslint-disable @typescript-eslint/no-explicit-any */

import { z } from 'zod';
import { SAFE_USER_LOOKUP_PROJECT } from '@bike4mind/common';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { DEFAULT_PAGE_SIZE, MetadataFilterSchema, type MetadataFilter } from './metadataFilterContract';

export { DEFAULT_PAGE_SIZE, type MetadataFilter };
/** Keeps one page comfortably under Lambda's 6MB response cap even for wide metadata. */
export const MAX_PAGE_SIZE = 5000;

/** Parses the JSON-encoded `metadataFilters` query param. Throws ZodError on anything unsafe. */
export function parseMetadataFilters(raw: string | undefined): MetadataFilter[] {
  if (!raw) return [];
  return z.array(MetadataFilterSchema).max(10).parse(JSON.parse(raw));
}

export interface UserActivityQueryParams {
  startDate: string;
  endDate: string;
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
          // A numeric/boolean metadata field never matches a regex, so each token widens to its
          // coerced scalar too - the same trick coerceValues already applies to `equals`.
          $in: String(value ?? '')
            .split(',')
            .map(v => v.trim())
            .filter(Boolean)
            .flatMap(v => [
              new RegExp(`^${regexSource(v)}$`, 'i'),
              ...coerceValues(v).filter(coerced => typeof coerced !== 'string'),
            ]),
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
  const matchCondition: any = {
    datetime: {
      $gte: new Date(`${startDate}T00:00:00.000Z`),
      $lte: new Date(`${endDate}T23:59:59.999Z`),
    },
  };

  const counterNameCondition = {
    ...(events?.length ? { $in: events } : {}),
    ...(counterName ? { $regex: escapeRegex(counterName), $options: 'i' } : {}),
  };
  if (Object.keys(counterNameCondition).length) {
    matchCondition.counterName = counterNameCondition;
  }

  // excludeOrgs wins over orgs, matching the pre-existing endpoint behaviour: the UI only
  // offers the exclusion checkboxes while "All Organizations" is selected.
  if (orgs?.length && !orgs.includes('all')) {
    matchCondition.userOrganization = { $in: orgs };
  }
  if (excludeOrgs?.length) {
    matchCondition.userOrganization = { $nin: excludeOrgs };
  }

  if (metadataFilters.length) {
    matchCondition.$and = metadataFilters.map(metadataCondition);
  }

  const pipeline: any[] = [
    { $match: matchCondition },
    { $addFields: { dateString: { $dateToString: { format: '%Y-%m-%d', date: '$datetime', timezone: 'UTC' } } } },
    {
      // Group BEFORE the join: userEmail/userOrganization are functionally determined by userId,
      // so joining once per grouped row instead of once per raw document is ~2x faster on a
      // 7-day production window. Preserved from the M1 reorder.
      $group: {
        _id: {
          date: '$dateString',
          counterName: '$counterName',
          userId: '$userId',
          metadata: '$metadata',
        },
        totalValue: { $sum: '$counterValue' },
        count: { $sum: 1 },
      },
    },
    {
      // $convert (not $toObjectId) so a non-ObjectId userId such as 'SYSTEM' yields null and
      // simply fails to join, instead of aborting the whole aggregation with a 500.
      $addFields: { userObjectId: { $convert: { input: '$_id.userId', to: 'objectId', onError: null } } },
    },
    {
      // Aggregation $lookup bypasses Mongoose select:false, so project off the shared
      // secret-free baseline plus the extra non-secret fields this route reads (email,
      // organization). Never add credential/secret fields here.
      $lookup: {
        from: usersCollection,
        localField: 'userObjectId',
        foreignField: '_id',
        pipeline: [{ $project: { ...SAFE_USER_LOOKUP_PROJECT, email: 1, organization: 1 } }],
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
    // missed shares the same '' fallback. Covering the whole group key (userId + metadata,
    // ordered by BSON comparison) makes the order unique, because the key is unique per row.
    {
      $sort: {
        '_id.date': -1,
        count: -1,
        '_id.counterName': 1,
        userEmail: 1,
        '_id.userId': 1,
        '_id.metadata': 1,
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
          userOrganization: '$user.organization',
          metadata: '$_id.metadata',
          count: 1,
          totalValue: 1,
        },
      },
    ],
    total: [{ $count: 'value' }],
  };

  return { pipeline, facetStages };
}
