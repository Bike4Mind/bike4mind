import type { FilterQuery, PipelineStage } from 'mongoose';
import { FeedbackTextModel } from '@bike4mind/database';
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

/**
 * Counts-only rollup over the feedback collection.
 *
 * `scope` is the caller's authorization filter, and it is the seam an organization-wide rollup
 * would reuse with `{ organizationId }` where the personal route passes `{ userId }` - which is
 * why the window handling lives here rather than in a route. The window is HALF-OPEN in UTC
 * (`$gte from`, `$lt to`): a report written at exactly `to` belongs to the next window, and both
 * callers must keep that convention or an organization total stops equalling the sum of the
 * personal totals under it at the bounds.
 */
export function buildFeedbackRollupPipeline(
  scope: FilterQuery<IFeedbackDocument>,
  from: Date,
  to: Date
): PipelineStage[] {
  // Fail closed at the seam an organization-wide rollup will reuse: an empty scope here would
  // aggregate every tenant, and that guarantee must live at the builder, not in one caller's 401.
  if (Object.keys(scope).length === 0) {
    throw new Error('buildFeedbackRollupPipeline requires a non-empty scope');
  }

  return [
    {
      // $and rather than a merged object literal: a scope can carry its own $and/$or arm and a
      // spread would silently drop one side of it (same reason as the feedback list route).
      $match: { $and: [scope, { createdAt: { $gte: from, $lt: to } }] },
    },
    {
      // Runs once here, before $facet, rather than per-arm. Existence only, never content -
      // $project: { _id: 1 } is load-bearing for this route's counts-only promise.
      $lookup: {
        from: FeedbackTextModel.collection.name,
        localField: '_id',
        foreignField: '_id',
        pipeline: [{ $project: { _id: 1 } }],
        as: 'textSibling',
      },
    },
    {
      $facet: {
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
                        {
                          $or: [{ $gt: [{ $size: '$textSibling' }, 0] }, { $ne: [{ $type: '$content' }, 'missing'] }],
                        },
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
                        { $eq: [{ $size: '$textSibling' }, 0] },
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
    },
  ];
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
