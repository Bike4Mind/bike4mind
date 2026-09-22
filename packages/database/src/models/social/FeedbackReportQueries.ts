import mongoose from 'mongoose';
import {
  FeedbackCountBucket,
  FeedbackSubject,
  IFeedbackDocument,
  OrgFeedbackItem,
  OrgFeedbackItemPage,
  OrgFeedbackMember,
  OrgFeedbackMemberCount,
  OrgFeedbackReport,
  ORG_FEEDBACK_BY_TAG_LIMIT,
  OrgMemberPopulation,
} from '@bike4mind/common';
import { FeedbackModel } from './FeedbackModel';
import { buildFeedbackWindowFilter } from './FeedbackRollupQueries';
import { userRepository } from '../auth/UserModel';
import { convertPipelineForDocumentDB, executeFacetCompatible } from '../../utils/documentdb-compat';

/** Bucket key standing in for a row whose grouped field was never set. */
const UNSPECIFIED = 'unspecified';

/** One key past the ceiling is fetched so truncation is a fact read off the returned rows rather
 * than a guess, matching `ARM_FETCH_LIMIT` in the personal rollup builder. */
const BY_TAG_FETCH_LIMIT = ORG_FEEDBACK_BY_TAG_LIMIT + 1;

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
  // Explicitly false, never left off: absence of this key is the contract's marker for a report
  // serialized before the field existed, and the summary worker copies it straight into an S3
  // artifact that no later producer fix can repair.
  byTagTruncated: false,
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

const toMembers = (userIds: string[], names: Map<string, string>): OrgFeedbackMember[] =>
  userIds.map(userId => ({ userId, displayName: names.get(userId) ?? userId }));

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

  // `aclOnly`, `stampOnly` and every `byMember.userId` below are all subsets of `members.userIds`
  // (the aggregate's own `$match` guarantees the latter), so this one lookup covers all three.
  const names = await resolveDisplayNames(members.userIds);
  const membership = {
    memberCount: members.userIds.length,
    aclOnly: toMembers(members.aclOnly, names),
    stampOnly: toMembers(members.stampOnly, names),
  };

  // No members means no authors to match. Also guards `$in: undefined` from a caller that omitted
  // the field, which would match everything rather than nothing.
  if (members.userIds.length === 0) {
    return { range, ...emptyCounts(), membership };
  }

  const basePipeline = [
    {
      $match: buildFeedbackWindowFilter(
        {
          // The stamp is an ObjectId on the schema; a raw string here matches zero rows silently.
          organizationId: new mongoose.Types.ObjectId(organizationId),
          userId: { $in: members.userIds },
          ...(subject ? { subject } : {}),
        },
        from,
        to
      ),
    },
  ];

  // `$dateToString`, not `$dateTrunc` - DocumentDB has neither `$dateTrunc` nor the pipeline form
  // of `$lookup`, which is also why member display names are resolved via a separate query above.
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
      // $setUnion before $unwind, matching the personal rollup's tags arm: the create contract
      // does not dedupe tags, so a report tagged the same thing twice would otherwise count twice
      // here and once there, and the two byTag breakdowns would not reconcile. The $isArray guard
      // keeps a non-array `tags` from hard-erroring every arm of this $facet, not just this one.
      { $addFields: { tags: { $setUnion: [{ $cond: [{ $isArray: '$tags' }, '$tags', []] }, []] } } },
      { $unwind: { path: '$tags', preserveNullAndEmptyArrays: false } },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $project: { _id: 0, key: '$_id', count: 1 } },
      { $sort: { count: -1 as const, key: 1 as const } },
      { $limit: BY_TAG_FETCH_LIMIT },
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
  const byTagRows = buckets(result?.byTag);

  return {
    range,
    totals: { count: result?.totals?.[0]?.count ?? 0 },
    byDay: result?.byDay ?? [],
    bySubject: buckets(result?.bySubject),
    byType: buckets(result?.byType),
    byStatus: buckets(result?.byStatus),
    byTag: byTagRows.slice(0, ORG_FEEDBACK_BY_TAG_LIMIT),
    byTagTruncated: byTagRows.length > ORG_FEEDBACK_BY_TAG_LIMIT,
    byMember: byMemberRows.map<OrgFeedbackMemberCount>(row => ({
      userId: row.userId,
      displayName: names.get(row.userId) ?? row.userId,
      count: row.count,
    })),
    membership,
  };
}

/**
 * The scope both drill-down reads run under. Every arm is a guard, not a filter: the org stamp
 * pins the tenant, and the author must still be in the union the counts were scoped on, so a row
 * written by someone who has since left the org drops out of the drill-down the same way it drops
 * out of the totals. A row failing either arm simply does not match, which is what lets the routes
 * answer one identical NotFoundError for missing, foreign-stamped and non-member-authored alike -
 * the drill-down cannot be used to probe which feedback ids exist.
 */
const drilldownScope = (organizationId: string, memberUserIds: string[]) => ({
  // The stamp is an ObjectId on the schema; a raw string here matches zero rows silently.
  organizationId: new mongoose.Types.ObjectId(organizationId),
  userId: { $in: memberUserIds },
});

type DrilldownRow = Pick<
  IFeedbackDocument,
  | 'userId'
  | 'username'
  | 'subject'
  | 'status'
  | 'type'
  | 'tags'
  | 'sessionId'
  | 'questId'
  | 'contentStored'
  | 'createdAt'
> & { _id: unknown };

/**
 * Explicit field list, never a document spread: `content` and `promptMeta` live on the same
 * document and neither may reach an org administrator (see `OrgFeedbackItem`). A field added to
 * the schema must be added here deliberately or it stays invisible, which is the safe default.
 */
const toItem = (row: DrilldownRow): OrgFeedbackItem => ({
  id: String(row._id),
  createdAt: row.createdAt.toISOString(),
  userId: row.userId,
  username: row.username,
  subject: row.subject,
  status: row.status,
  type: row.type,
  tags: row.tags ?? [],
  sessionId: row.sessionId,
  questId: row.questId,
  contentStored: row.contentStored ?? false,
});

/**
 * The rows behind a report cell, newest first. Same scope and same window as `orgFeedbackReport`,
 * so a cell's count and the page under it are answers to one question.
 */
export async function orgFeedbackItems(params: {
  organizationId: string;
  from: Date;
  to: Date;
  members: OrgMemberPopulation;
  subject?: FeedbackSubject;
  limit: number;
  offset: number;
}): Promise<OrgFeedbackItemPage> {
  const { organizationId, from, to, members, subject, limit, offset } = params;
  // No members means no authors to match. Also guards `$in: undefined`, which would match
  // everything rather than nothing.
  if (members.userIds.length === 0) return { items: [], total: 0, limit, offset };

  // One filter object for both the page and its total, so the two cannot disagree on the window.
  const filter = buildFeedbackWindowFilter(
    { ...drilldownScope(organizationId, members.userIds), ...(subject ? { subject } : {}) },
    from,
    to
  );

  // `_id` breaks the tie: `createdAt` alone is not unique, and an unstable sort silently repeats
  // or skips rows across pages.
  const [rows, total] = await Promise.all([
    FeedbackModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit).lean(),
    FeedbackModel.countDocuments(filter),
  ]);

  return { items: rows.map(toItem), total, limit, offset };
}

/** One row behind a report cell, or null for every denial - see `drilldownScope`. */
export async function orgFeedbackItem(params: {
  organizationId: string;
  feedbackId: string;
  members: OrgMemberPopulation;
}): Promise<OrgFeedbackItem | null> {
  const { organizationId, feedbackId, members } = params;
  if (members.userIds.length === 0) return null;

  const row = await FeedbackModel.findOne({
    _id: new mongoose.Types.ObjectId(feedbackId),
    ...drilldownScope(organizationId, members.userIds),
  }).lean();

  return row ? toItem(row) : null;
}
