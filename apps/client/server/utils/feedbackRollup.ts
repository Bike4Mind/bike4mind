import type { FilterQuery, PipelineStage } from 'mongoose';
import {
  FEEDBACK_CONTENT_RETENTION_DAYS,
  FEEDBACK_ROLLUP_TOP_N,
  type FeedbackRollupDimension,
  type FeedbackRollupResponse,
  type IFeedbackDocument,
} from '@bike4mind/common';

const DAY_MS = 24 * 60 * 60 * 1000;

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
  to: Date,
  now: Date = new Date()
): PipelineStage[] {
  // A report's text lives on a TTL'd sibling, so `contentStored: true` only means the text was
  // written once - past this cutoff the sibling row has expired and the text is no longer readable.
  const textCutoff = new Date(now.getTime() - FEEDBACK_CONTENT_RETENTION_DAYS * DAY_MS);

  return [
    {
      // $and rather than a merged object literal: a scope can carry its own $and/$or arm and a
      // spread would silently drop one side of it (same reason as the feedback list route).
      $match: { $and: [scope, { createdAt: { $gte: from, $lt: to } }] },
    },
    {
      $facet: {
        total: [{ $count: 'count' }],
        textAvailability: [
          {
            $group: {
              _id: null,
              stored: {
                $sum: {
                  $cond: [{ $and: [{ $eq: ['$contentStored', true] }, { $gte: ['$createdAt', textCutoff] }] }, 1, 0],
                },
              },
              expired: {
                $sum: {
                  $cond: [{ $and: [{ $eq: ['$contentStored', true] }, { $lt: ['$createdAt', textCutoff] }] }, 1, 0],
                },
              },
            },
          },
        ],
        // Both keys are optional on the model, and `$ne: null` drops a missing field as well as
        // an explicitly null one, so an unattributed report counts in `total` and nowhere else.
        sessionId: countArm('sessionId', [{ $match: { sessionId: { $ne: null } } }]),
        questId: countArm('questId', [{ $match: { questId: { $ne: null } } }]),
        subject: countArm('subject'),
        status: countArm('status'),
        // $setUnion before $unwind: the create contract does not dedupe tags, so a report tagged
        // the same thing twice would otherwise count twice against that tag.
        tags: countArm('tags', [
          { $addFields: { tags: { $setUnion: ['$tags', []] } } },
          { $unwind: { path: '$tags', preserveNullAndEmptyArrays: false } },
        ]),
      },
    },
  ];
}

function toDimension(raw: RawBucket[] | undefined): FeedbackRollupDimension {
  const rows = raw ?? [];
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
