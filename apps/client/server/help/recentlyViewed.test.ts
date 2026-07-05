import { describe, it, expect } from 'vitest';
import type { PipelineStage } from 'mongoose';
import { buildRecentlyViewedPipeline, MAX_RECENTLY_VIEWED } from './recentlyViewed';

describe('buildRecentlyViewedPipeline', () => {
  it('matches only article_view events for the user with a non-empty slug', () => {
    const stages = buildRecentlyViewedPipeline('user-1');
    const match = stages[0] as PipelineStage.Match;
    expect(match.$match).toEqual({ type: 'article_view', userId: 'user-1', slug: { $nin: [null, ''] } });
  });

  it('dedupes by slug keeping the latest view (sort-desc before group $first)', () => {
    const stages = buildRecentlyViewedPipeline('u');
    const preSort = stages[1] as PipelineStage.Sort;
    const group = stages[2] as PipelineStage.Group;
    expect(preSort.$sort).toEqual({ createdAt: -1 });
    expect(group.$group._id).toBe('$slug');
    expect(group.$group.viewedAt).toEqual({ $first: '$createdAt' });
  });

  it('orders the deduped results newest first', () => {
    const stages = buildRecentlyViewedPipeline('u');
    const postSort = stages[3] as PipelineStage.Sort;
    expect(postSort.$sort).toEqual({ viewedAt: -1 });
  });

  it('clamps an oversized limit down to MAX_RECENTLY_VIEWED', () => {
    const stages = buildRecentlyViewedPipeline('u', 999);
    const limit = stages[4] as PipelineStage.Limit;
    expect(limit.$limit).toBe(MAX_RECENTLY_VIEWED);
  });

  it('clamps a non-positive limit up to 1', () => {
    const stages = buildRecentlyViewedPipeline('u', 0);
    const limit = stages[4] as PipelineStage.Limit;
    expect(limit.$limit).toBe(1);
  });
});
