import mongoose from 'mongoose';
import {
  FeedbackCountBucket,
  FeedbackSubject,
  OrgFeedbackMember,
  OrgFeedbackMemberCount,
  OrgFeedbackReport,
  OrgMemberPopulation,
} from '@bike4mind/common';
import { FeedbackModel } from './FeedbackModel';
import { userRepository } from '../auth/UserModel';
import { convertPipelineForDocumentDB, executeFacetCompatible } from '../../utils/documentdb-compat';

/** Bucket key standing in for a row whose grouped field was never set. */
const UNSPECIFIED = 'unspecified';

const BY_TAG_LIMIT = 50;

// any: a $group _id is either a field path or an aggregation expression, and Mongoose's typed
// PipelineStage union does not admit both here. See documentdb-compat's module header.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const keyedFacet = (expr: any) => [
  { $group: { _id: expr, count: { $sum: 1 } } },
  { $project: { _id: 0, key: '$_id', count: 1 } },
  { $sort: { count: -1 as const, key: 1 as const } },
];

const buckets = (rows: FeedbackCountBucket[] | undefined): FeedbackCountBucket[] =>
  (rows ?? []).map(row => ({ key: String(row.key ?? UNSPECIFIED), count: row.count }));

const emptyCounts = () => ({
  totals: { count: 0 },
  byDay: [],
  bySubject: [],
  byType: [],
  byStatus: [],
  byTag: [],
  byMember: [],
});

/**
 * `name` -> `username` -> `email` -> the raw id. `||` rather than `??` on purpose: a blank name is
 * as useless to a reader as a missing one, and User carries rows with both.
 */
async function resolveDisplayNames(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const users = await userRepository.findByIds(userIds);
  return new Map(users.map(user => [String(user.id), user.name || user.username || user.email || String(user.id)]));
}

async function resolveMembers(userIds: string[]): Promise<OrgFeedbackMember[]> {
  const names = await resolveDisplayNames(userIds);
  return userIds.map(userId => ({ userId, displayName: names.get(userId) ?? userId }));
}

/**
 * Org-scoped rollup of member-authored feedback. Lives beside the model rather than in the route,
 * matching the usage rollup (`usageEventRepository.ownerUsageSummary`).
 *
 * Takes the whole `OrgMemberPopulation`, not just its `userIds`: the report scopes on the union of
 * the org ACL and the org stamp, and the two one-sided lists are what let a reader tell a count
 * both sources agree on from one resting on a single source. Dropping them here would only make
 * the route re-derive them.
 */
export async function orgFeedbackReport(params: {
  organizationId: string;
  from: Date;
  to: Date;
  members: OrgMemberPopulation;
  subject?: FeedbackSubject;
}): Promise<OrgFeedbackReport> {
  const { organizationId, from, to, members, subject } = params;
  const range = { from: from.toISOString(), to: to.toISOString() };

  const membership = {
    memberCount: members.userIds.length,
    aclOnly: await resolveMembers(members.aclOnly),
    stampOnly: await resolveMembers(members.stampOnly),
  };

  // No members means no authors to match. Also guards `$in: undefined` from a caller that omitted
  // the field, which would match everything rather than nothing.
  if (members.userIds.length === 0) {
    return { range, ...emptyCounts(), membership };
  }

  const basePipeline = [
    {
      $match: {
        // The stamp is an ObjectId on the schema; a raw string here matches zero rows silently.
        organizationId: new mongoose.Types.ObjectId(organizationId),
        userId: { $in: members.userIds },
        createdAt: { $gte: from, $lte: to },
        ...(subject ? { subject } : {}),
      },
    },
  ];

  // `$dateToString`, not `$dateTrunc` - DocumentDB has neither `$dateTrunc` nor the pipeline form
  // of `$lookup`, which is also why member display names are resolved in a second query below.
  const facetStages: Record<string, unknown[]> = {
    totals: [{ $group: { _id: null, count: { $sum: 1 } } }, { $project: { _id: 0, count: 1 } }],
    byDay: [
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
          count: { $sum: 1 },
        },
      },
      { $project: { _id: 0, day: '$_id', count: 1 } },
      { $sort: { day: 1 } },
    ],
    bySubject: keyedFacet('$subject'),
    // `type` and `status` are optional on the schema, so those rows group under a literal bucket
    // rather than dropping out of a histogram meant to reconcile against `totals`.
    byType: keyedFacet({ $ifNull: ['$type', UNSPECIFIED] }),
    byStatus: keyedFacet({ $ifNull: ['$status', UNSPECIFIED] }),
    // Tags are free-form, so their key space is unbounded - capped, unlike the groupings above,
    // whose keys are enum-sized and whose member list is bounded by the org's seat cap.
    byTag: [
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $project: { _id: 0, key: '$_id', count: 1 } },
      { $sort: { count: -1 as const, key: 1 as const } },
      { $limit: BY_TAG_LIMIT },
    ],
    byMember: [
      { $group: { _id: '$userId', count: { $sum: 1 } } },
      { $project: { _id: 0, userId: '$_id', count: 1 } },
      { $sort: { count: -1 as const, userId: 1 as const } },
    ],
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const converted: Record<string, any[]> = {};
  Object.entries(facetStages).forEach(([key, stages]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    converted[key] = convertPipelineForDocumentDB(stages as any[]);
  });

  const [result] = await executeFacetCompatible(
    FeedbackModel,
    convertPipelineForDocumentDB(basePipeline as any[]),
    converted
  );

  const byMemberRows: { userId: string; count: number }[] = result?.byMember ?? [];
  const names = await resolveDisplayNames(byMemberRows.map(row => row.userId));

  return {
    range,
    totals: { count: result?.totals?.[0]?.count ?? 0 },
    byDay: result?.byDay ?? [],
    bySubject: buckets(result?.bySubject),
    byType: buckets(result?.byType),
    byStatus: buckets(result?.byStatus),
    byTag: buckets(result?.byTag),
    byMember: byMemberRows.map<OrgFeedbackMemberCount>(row => ({
      userId: row.userId,
      displayName: names.get(row.userId) ?? row.userId,
      count: row.count,
    })),
    membership,
  };
}
