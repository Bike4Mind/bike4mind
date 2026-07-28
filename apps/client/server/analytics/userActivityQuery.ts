/**
 * Builds the User Activity aggregation for GET /api/users/counterLogs.
 *
 * The pipeline emits one flat row per (day, counter, user, metadata) - the exact row the
 * admin Analytics grid renders - and pages it server-side. The previous shape re-grouped
 * rows into a nested `users[]` array and returned every match unpaginated, which reached
 * ~17MB on production data and tripped Lambda's 6MB response cap (413 -> 502).
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

export const DEFAULT_PAGE_SIZE = 25;
/** Keeps one page comfortably under Lambda's 6MB response cap even for wide metadata. */
export const MAX_PAGE_SIZE = 5000;

/**
 * Metadata paths are interpolated into Mongo field keys, so they are allowlisted rather
 * than escaped: letters-first segments only, which rules out `$`-prefixed operators and
 * `__proto__`.
 */
const METADATA_FIELD = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*){0,4}$/;

const MetadataFilterSchema = z.object({
  field: z.string().max(64).regex(METADATA_FIELD),
  operator: z.enum(['equals', 'contains', 'in', 'exists', 'not_exists']),
  value: z.unknown().optional(),
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
  page: number;
  limit: number;
  events?: string[];
  orgs?: string[];
  excludeOrgs?: string[];
  counterName?: string;
  userEmail?: string;
  metadataFilters?: MetadataFilter[];
  usersCollection?: string;
}

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
      return { [path]: { $regex: escapeRegex(String(value ?? '')), $options: 'i' } };
    case 'in':
      return {
        [path]: {
          $in: String(value ?? '')
            .split(',')
            .map(v => v.trim())
            .filter(Boolean)
            .map(v => new RegExp(`^${escapeRegex(v)}$`, 'i')),
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
  page,
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
    // in-memory limit, and counterName/userEmail break ties so a row can't straddle pages.
    { $sort: { '_id.date': -1, count: -1, '_id.counterName': 1, userEmail: 1 } },
  ];

  const facetStages: Record<string, any[]> = {
    rows: [
      { $skip: (page - 1) * limit },
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
