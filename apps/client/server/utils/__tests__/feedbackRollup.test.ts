import { describe, it, expect } from 'vitest';
import { FeedbackTextModel } from '@bike4mind/database';
import { FEEDBACK_ROLLUP_TOP_N } from '@bike4mind/common';
import { buildFeedbackRollupPipeline, toFeedbackRollupResponse, type FeedbackRollupFacet } from '../feedbackRollup';

const FROM = new Date('2026-01-01T00:00:00.000Z');
const TO = new Date('2026-02-01T00:00:00.000Z');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stages = (scope: Record<string, unknown>) => buildFeedbackRollupPipeline(scope, FROM, TO).pipeline as any[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const facetOf = (scope: Record<string, unknown>) => buildFeedbackRollupPipeline(scope, FROM, TO).facetStages as any;

describe('buildFeedbackRollupPipeline', () => {
  it('composes the caller scope with $and so a scope carrying its own $or survives', () => {
    const scope = { $or: [{ userId: 'a' }, { userId: 'b' }] };
    const [match] = stages(scope);

    expect(match.$match.$and[0]).toEqual(scope);
    expect(match.$match.$and[1].createdAt.$gte).toEqual(FROM);
  });

  it('bounds the window inclusively - $gte on the lower bound, $lte on the upper, never $lt', () => {
    const [match] = stages({ userId: 'a' });
    const bounds = match.$match.$and[1].createdAt;

    // Matches the org report's own bounds (FeedbackReportQueries.orgFeedbackReport), which is what
    // lets an org total reconcile against the personal rollups under it.
    expect(Object.keys(bounds).sort()).toEqual(['$gte', '$lte']);
    expect(bounds.$lte).toEqual(TO);
  });

  it('excludes a missing or null sessionId and questId from their own dimensions only', () => {
    const facet = facetOf({ userId: 'a' });

    expect(facet.sessionId[0]).toEqual({ $match: { sessionId: { $ne: null } } });
    expect(facet.questId[0]).toEqual({ $match: { questId: { $ne: null } } });
    expect(facet.total).toEqual([{ $count: 'count' }]);
  });

  it('dedupes tags before unwinding them', () => {
    const facet = facetOf({ userId: 'a' });

    expect(facet.tags[0]).toEqual({
      $addFields: { tags: { $setUnion: [{ $cond: [{ $isArray: '$tags' }, '$tags', []] }, []] } },
    });
    expect(facet.tags[1].$unwind.path).toBe('$tags');
    expect(facet.tags[1].$unwind.preserveNullAndEmptyArrays).toBe(false);
  });

  it('coerces a non-array tags field to an empty array instead of hard-erroring $setUnion', () => {
    const facet = facetOf({ userId: 'a' });
    const cond = facet.tags[0].$addFields.tags.$setUnion[0].$cond;

    expect(cond).toEqual([{ $isArray: '$tags' }, '$tags', []]);
  });

  it('throws rather than aggregate over every tenant when scope is empty', () => {
    expect(() => buildFeedbackRollupPipeline({}, FROM, TO)).toThrow();
  });

  it('throws when the only key is undefined - Mongoose would strip it, leaving an unconstrained match', () => {
    expect(() => buildFeedbackRollupPipeline({ userId: undefined }, FROM, TO)).toThrow();
  });

  it('throws when every key of a multi-key scope is null or undefined', () => {
    expect(() => buildFeedbackRollupPipeline({ userId: null, organizationId: undefined }, FROM, TO)).toThrow();
  });

  it('does not throw for a real falsy constraint like `false`', () => {
    expect(() => buildFeedbackRollupPipeline({ someFlag: false }, FROM, TO)).not.toThrow();
  });

  it('joins the FeedbackText sibling by _id using the plain localField/foreignField form, with no pipeline key', () => {
    const [, lookup] = stages({ userId: 'a' });

    // Regression pin: a $lookup with both localField/foreignField AND a pipeline is passed
    // through untouched by convertLookupForDocumentDB, which only certifies the plain form.
    expect(lookup.$lookup).not.toHaveProperty('pipeline');
    expect(lookup.$lookup).toEqual({
      from: FeedbackTextModel.collection.name,
      localField: '_id',
      foreignField: '_id',
      as: 'textSibling',
    });
  });

  it('reduces the joined sibling to a boolean and drops it before the facet stage', () => {
    const [, , addFields, project] = stages({ userId: 'a' });

    expect(addFields).toEqual({ $addFields: { hasText: { $gt: [{ $size: '$textSibling' }, 0] } } });
    expect(project).toEqual({ $project: { textSibling: 0 } });
  });

  it('caps every dimension one key past the ceiling so truncation can be detected', () => {
    const facet = facetOf({ userId: 'a' });

    for (const arm of ['sessionId', 'questId', 'subject', 'status', 'tags']) {
      const limit = facet[arm].at(-1);
      expect(limit).toEqual({ $limit: FEEDBACK_ROLLUP_TOP_N + 1 });
    }
  });

  it('derives text availability from the joined-sibling boolean and $content type, never a createdAt cutoff', () => {
    const facet = facetOf({ userId: 'a' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const group = (facet.textAvailability[0] as any).$group;

    expect(group.stored.$sum.$cond[0].$and).toEqual([
      { $eq: ['$contentStored', true] },
      { $or: ['$hasText', { $ne: [{ $type: '$content' }, 'missing'] }] },
    ]);
    expect(group.expired.$sum.$cond[0].$and).toEqual([
      { $eq: ['$contentStored', true] },
      { $eq: ['$hasText', false] },
      { $eq: [{ $type: '$content' }, 'missing'] },
    ]);
  });
});

describe('toFeedbackRollupResponse', () => {
  it('returns zeros and empty dimensions for a window with no reports, never a 404 shape', () => {
    const response = toFeedbackRollupResponse(undefined, FROM, TO);

    expect(response.total).toBe(0);
    expect(response.textAvailability).toEqual({ stored: 0, expired: 0 });
    expect(response.buckets.sessionId).toEqual({ buckets: [], truncated: false });
    expect(response.buckets.tags).toEqual({ buckets: [], truncated: false });
    expect(response.from).toBe(FROM.toISOString());
    expect(response.to).toBe(TO.toISOString());
  });

  it('truncates a dimension at the ceiling and says so', () => {
    const overflowing = Array.from({ length: FEEDBACK_ROLLUP_TOP_N + 1 }, (_, index) => ({
      _id: `session-${index}`,
      count: 100 - index,
    }));
    const facet: FeedbackRollupFacet = {
      total: [{ count: 500 }],
      textAvailability: [{ stored: 4, expired: 1 }],
      sessionId: overflowing,
      questId: [{ _id: 'quest-1', count: 2 }],
      subject: [],
      status: [],
      tags: [],
    };

    const response = toFeedbackRollupResponse(facet, FROM, TO);

    expect(response.buckets.sessionId.buckets).toHaveLength(FEEDBACK_ROLLUP_TOP_N);
    expect(response.buckets.sessionId.truncated).toBe(true);
    expect(response.buckets.questId.truncated).toBe(false);
    expect(response.total).toBe(500);
    expect(response.topN).toBe(FEEDBACK_ROLLUP_TOP_N);
    expect(response.textAvailability).toEqual({ stored: 4, expired: 1 });
  });
});
