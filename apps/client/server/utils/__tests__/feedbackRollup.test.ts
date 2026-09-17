import { describe, it, expect } from 'vitest';
import { FEEDBACK_CONTENT_RETENTION_DAYS, FEEDBACK_ROLLUP_TOP_N } from '@bike4mind/common';
import { buildFeedbackRollupPipeline, toFeedbackRollupResponse, type FeedbackRollupFacet } from '../feedbackRollup';

const FROM = new Date('2026-01-01T00:00:00.000Z');
const TO = new Date('2026-02-01T00:00:00.000Z');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stages = (scope: Record<string, unknown>) => buildFeedbackRollupPipeline(scope, FROM, TO) as any[];

describe('buildFeedbackRollupPipeline', () => {
  it('composes the caller scope with $and so a scope carrying its own $or survives', () => {
    const scope = { $or: [{ userId: 'a' }, { userId: 'b' }] };
    const [match] = stages(scope);

    expect(match.$match.$and[0]).toEqual(scope);
    expect(match.$match.$and[1].createdAt.$gte).toEqual(FROM);
  });

  it('bounds the window half-open - $gte on the lower bound, $lt on the upper, never $lte', () => {
    const [match] = stages({ userId: 'a' });
    const bounds = match.$match.$and[1].createdAt;

    expect(Object.keys(bounds).sort()).toEqual(['$gte', '$lt']);
    expect(bounds.$lt).toEqual(TO);
  });

  it('excludes a missing or null sessionId and questId from their own dimensions only', () => {
    const [, facet] = stages({ userId: 'a' });

    expect(facet.$facet.sessionId[0]).toEqual({ $match: { sessionId: { $ne: null } } });
    expect(facet.$facet.questId[0]).toEqual({ $match: { questId: { $ne: null } } });
    expect(facet.$facet.total).toEqual([{ $count: 'count' }]);
  });

  it('dedupes tags before unwinding them', () => {
    const [, facet] = stages({ userId: 'a' });

    expect(facet.$facet.tags[0]).toEqual({ $addFields: { tags: { $setUnion: ['$tags', []] } } });
    expect(facet.$facet.tags[1].$unwind.path).toBe('$tags');
    expect(facet.$facet.tags[1].$unwind.preserveNullAndEmptyArrays).toBe(false);
  });

  it('caps every dimension one key past the ceiling so truncation can be detected', () => {
    const [, facet] = stages({ userId: 'a' });

    for (const arm of ['sessionId', 'questId', 'subject', 'status', 'tags']) {
      const limit = facet.$facet[arm].at(-1);
      expect(limit).toEqual({ $limit: FEEDBACK_ROLLUP_TOP_N + 1 });
    }
  });

  it('splits text availability at the retention cutoff, counted off contentStored', () => {
    const now = new Date('2026-04-15T00:00:00.000Z');
    const [, facet] = buildFeedbackRollupPipeline({ userId: 'a' }, FROM, TO, now) as [
      unknown,
      { $facet: Record<string, unknown[]> },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const group = (facet.$facet.textAvailability[0] as any).$group;
    const cutoff = new Date(now.getTime() - FEEDBACK_CONTENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    expect(group.stored.$sum.$cond[0].$and).toEqual([
      { $eq: ['$contentStored', true] },
      { $gte: ['$createdAt', cutoff] },
    ]);
    expect(group.expired.$sum.$cond[0].$and).toEqual([
      { $eq: ['$contentStored', true] },
      { $lt: ['$createdAt', cutoff] },
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
