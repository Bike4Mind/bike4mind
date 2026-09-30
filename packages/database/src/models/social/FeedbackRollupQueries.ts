import type { FilterQuery, PipelineStage } from 'mongoose';
import { FeedbackTextModel } from './FeedbackTextModel';
import {
  FEEDBACK_CONTENT_RETENTION_DAYS,
  FEEDBACK_ROLLUP_TOP_N,
  type FeedbackRollupDimension,
  type FeedbackRollupResponse,
  type IFeedbackDocument,
} from '@bike4mind/common';

/** One key past the ceiling is fetched per dimension so `truncated` is a fact read off the data
 * rather than inferred from a full page. */
const ARM_FETCH_LIMIT = FEEDBACK_ROLLUP_TOP_N + 1;

interface RawBucket {
  _id: string | null;
  count: number;
}

/** Shape of the single document the $facet stage returns. */
export interface FeedbackRollupFacet {
  total: Array<{ count: number }>;
  textAvailability: Array<{ stored: number; expired: number }>;
  sessionId: RawBucket[];
  questId: RawBucket[];
  subject: RawBucket[];
  status: RawBucket[];
  tags: RawBucket[];
}

function countArm(field: string, prelude: PipelineStage.FacetPipelineStage[] = []): PipelineStage.FacetPipelineStage[] {
  return [
    ...prelude,
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    // `_id` breaks the tie so which keys survive truncation is stable across runs.
    { $sort: { count: -1, _id: 1 } },
    { $limit: ARM_FETCH_LIMIT },
  ];
}

/** The prefix pipeline (match + lookup) and the per-dimension facet stages, kept separate so the
 * caller can run them through `executeFacetCompatible` rather than a raw `$facet` stage. */
export interface FeedbackRollupPipeline {
  pipeline: PipelineStage[];
  facetStages: Record<string, PipelineStage.FacetPipelineStage[]>;
}

/**
 * The window seam these feedback aggregations compose their authorization scope through - the
 * personal rollup below and, in FeedbackReportQueries, the org report and its drill-down list.
 * The window is INCLUSIVE at both ends in UTC (`$gte from`, `$lte to`): `to` is the last instant
 * counted, not the first instant of the next window. The price is that two windows sharing an
 * instant both count the row on it - the org routes round `to` to 23:59:59.999 so adjacent org
 * windows never meet, and the personal client (apps/client/app/utils/feedbackRollupWindow.ts)
 * sends `to = now` and never tiles.
 *
 * Deliberately does not round its bounds. Rounding lives in apps/client/server/utils/
 * orgFeedbackWindow.ts, because the org summary queue handler hands orgFeedbackReport instants it
 * has already rounded and keyed its job on - rounding again here would move that key.
 */
export function buildFeedbackWindowFilter(
  scope: FilterQuery<IFeedbackDocument>,
  from: Date,
  to: Date
): FilterQuery<IFeedbackDocument> {
  // Fail closed: Mongoose strips null/undefined values, so a scope with none surviving would
  // match like {} and aggregate every tenant.
  if (Object.values(scope).every(value => value === null || value === undefined)) {
    throw new Error('buildFeedbackWindowFilter requires a scope with at least one non-null constraint');
  }

  // $and rather than a merged object literal: a scope can carry its own $and/$or arm and a spread
  // would silently drop one side of it (same reason as the feedback list route). MongoDB's planner
  // normalizes $and onto the same compound indexes a flat filter would use; FeedbackModel's header
  // warns that DocumentDB plans this collection differently, and that engine is not covered here.
  return { $and: [scope, { createdAt: { $gte: from, $lte: to } }] };
}

/**
 * Counts-only rollup over the feedback collection.
 *
 * `scope` is the caller's authorization filter - `{ userId }` for the personal route - and it
 * reaches the window through `buildFeedbackWindowFilter`, the same seam the org routes use.
 */
export function buildFeedbackRollupPipeline(
  scope: FilterQuery<IFeedbackDocument>,
  from: Date,
  to: Date
): FeedbackRollupPipeline {
  return {
    pipeline: [
      { $match: buildFeedbackWindowFilter(scope, from, to) },
      {
        // Plain localField/foreignField form (no `pipeline`) - the only $lookup shape DocumentDB
        // supports. Reduced to a boolean and dropped before $facet so no joined text ever reaches
        // an arm or the response.
        $lookup: {
          from: FeedbackTextModel.collection.name,
          localField: '_id',
          foreignField: '_id',
          as: 'textSibling',
        },
      },
      { $addFields: { hasText: { $gt: [{ $size: '$textSibling' }, 0] } } },
      { $project: { textSibling: 0 } },
    ],
    facetStages: {
      total: [{ $count: 'count' }],
      textAvailability: [
        {
          $group: {
            _id: null,
            // Mirrors hydrateFeedbackText's `sibling?.content ?? item.content`: a live sibling
            // row or a non-missing inline `content` (an explicit null counts as present - only
            // an absent field is "expired") both mean the text is readable.
            stored: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$contentStored', true] },
                      { $or: ['$hasText', { $ne: [{ $type: '$content' }, 'missing'] }] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            expired: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$contentStored', true] },
                      { $eq: ['$hasText', false] },
                      { $eq: [{ $type: '$content' }, 'missing'] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ],
      // Both keys are optional on the model, and `$ne: null` drops a missing field as well as
      // an explicitly null one - that only excludes the report from its OWN dimension, it still
      // counts in `total`, `subject`, and `status`.
      sessionId: countArm('sessionId', [{ $match: { sessionId: { $ne: null } } }]),
      questId: countArm('questId', [{ $match: { questId: { $ne: null } } }]),
      subject: countArm('subject'),
      status: countArm('status'),
      // $setUnion before $unwind: the create contract does not dedupe tags, so a report tagged
      // the same thing twice would otherwise count twice against that tag. A non-array `tags`
      // would otherwise hard-error $setUnion and 500 every arm in this $facet, not just this one.
      tags: countArm('tags', [
        { $addFields: { tags: { $setUnion: [{ $cond: [{ $isArray: '$tags' }, '$tags', []] }, []] } } },
        { $unwind: { path: '$tags', preserveNullAndEmptyArrays: false } },
      ]),
    },
  };
}

function toDimension(raw: RawBucket[] | undefined): FeedbackRollupDimension {
  // subject/status are `required: true` on FeedbackModel, so a null `_id` here can only be a
  // legacy row predating the field - drop it before slicing, or String(null) would render as the
  // indistinguishable literal "null" and `truncated` would be counting a key that isn't shown.
  const rows = (raw ?? []).filter(row => row._id !== null && row._id !== undefined);
  return {
    buckets: rows.slice(0, FEEDBACK_ROLLUP_TOP_N).map(row => ({ key: String(row._id), count: row.count })),
    truncated: rows.length > FEEDBACK_ROLLUP_TOP_N,
  };
}

/** Projects the raw facet document onto the wire contract. Separate from the pipeline so both
 * rollup routes present identical bucket shapes, including the empty case. */
export function toFeedbackRollupResponse(
  facet: FeedbackRollupFacet | undefined,
  from: Date,
  to: Date
): FeedbackRollupResponse {
  const availability = facet?.textAvailability?.[0];

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    total: facet?.total?.[0]?.count ?? 0,
    topN: FEEDBACK_ROLLUP_TOP_N,
    textRetentionDays: FEEDBACK_CONTENT_RETENTION_DAYS,
    textAvailability: { stored: availability?.stored ?? 0, expired: availability?.expired ?? 0 },
    buckets: {
      sessionId: toDimension(facet?.sessionId),
      questId: toDimension(facet?.questId),
      subject: toDimension(facet?.subject),
      status: toDimension(facet?.status),
      tags: toDimension(facet?.tags),
    },
  };
}
