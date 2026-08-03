import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import { sortModelsForPicker } from '../modelRanking';
import { ModelBackend, ModelInfo } from '@bike4mind/common';

// Dates are resolved relative to now because isNewModel uses a rolling 3-month window,
// so hardcoded dates would silently stop being "new" as the calendar moves.
const daysAgo = (n: number) => dayjs().subtract(n, 'day').format('YYYY-MM-DD');
const RECENT = daysAgo(10); // inside the NEW window
const OLDER_RECENT = daysAgo(40); // also NEW, but not the newest
const STALE = daysAgo(400); // outside the NEW window

function createModel(overrides: Partial<ModelInfo> & { name: string }): ModelInfo {
  return {
    id: overrides.name,
    type: 'text',
    backend: ModelBackend.Anthropic,
    contextWindow: 200000,
    max_tokens: 8192,
    supportsTools: true,
    supportsVision: true,
    supportsImageVariation: false,
    ...overrides,
  } as ModelInfo;
}

const names = (models: ModelInfo[]) => models.map(m => m.name);

describe('sortModelsForPicker', () => {
  it('puts newly released models first, even over a better admin rank', () => {
    const curatedDefault = createModel({ name: 'curated', rank: 0, releaseDate: STALE });
    const justLaunched = createModel({ name: 'launched', rank: 50, releaseDate: RECENT });

    expect(names(sortModelsForPicker([curatedDefault, justLaunched]))).toEqual(['launched', 'curated']);
  });

  it('puts an unranked new model first - the case admin rank misses entirely', () => {
    const ranked = createModel({ name: 'ranked', rank: 0, releaseDate: STALE });
    const unrankedButNew = createModel({ name: 'unranked-new', releaseDate: RECENT });

    expect(names(sortModelsForPicker([ranked, unrankedButNew]))).toEqual(['unranked-new', 'ranked']);
  });

  it('orders the new models among themselves by release date, ahead of their rank', () => {
    // The real case: Claude 5 Opus is the newest model in the catalog but sits at rank 1,
    // so ranking first would bury it under an older rank-0 model.
    const newestButLowerRank = createModel({ name: 'newest', rank: 1, releaseDate: RECENT });
    const olderTopRank = createModel({ name: 'older', rank: 0, releaseDate: OLDER_RECENT });

    expect(names(sortModelsForPicker([olderTopRank, newestButLowerRank]))).toEqual(['newest', 'older']);
  });

  it('falls back to rank for two models released the same day', () => {
    const sameDayRank1 = createModel({ name: 'rank1', rank: 1, releaseDate: RECENT });
    const sameDayRank0 = createModel({ name: 'rank0', rank: 0, releaseDate: RECENT });

    expect(names(sortModelsForPicker([sameDayRank1, sameDayRank0]))).toEqual(['rank0', 'rank1']);
  });

  it('respects admin rank once neither model is new', () => {
    const rank5 = createModel({ name: 'rank5', rank: 5, releaseDate: STALE });
    const rank1 = createModel({ name: 'rank1', rank: 1, releaseDate: STALE });

    expect(names(sortModelsForPicker([rank5, rank1]))).toEqual(['rank1', 'rank5']);
  });

  it('sorts ranked models before unranked ones', () => {
    const unranked = createModel({ name: 'unranked' });
    const ranked = createModel({ name: 'ranked', rank: 3 });

    expect(names(sortModelsForPicker([unranked, ranked]))).toEqual(['ranked', 'unranked']);
  });

  it('breaks a shared rank by release date, newest first', () => {
    // The case that decides most of the real list: rank 0 and rank 1 hold over 40% of the
    // catalog between them, so this tiebreak is what users actually see.
    const olderSameRank = createModel({ name: 'older', rank: 1, releaseDate: daysAgo(500) });
    const newerSameRank = createModel({ name: 'newer', rank: 1, releaseDate: STALE });

    expect(names(sortModelsForPicker([olderSameRank, newerSameRank]))).toEqual(['newer', 'older']);
  });

  it('sends models with no release date to the bottom of their rank', () => {
    const undated = createModel({ name: 'undated', rank: 1 });
    const dated = createModel({ name: 'dated', rank: 1, releaseDate: STALE });

    expect(names(sortModelsForPicker([undated, dated]))).toEqual(['dated', 'undated']);
  });

  it('does not treat trainingCutoff as a release date', () => {
    // trainingCutoff always predates release, so using it as a fallback would rank a model
    // that only has a cutoff below every model carrying a real release date.
    const cutoffOnly = createModel({ name: 'cutoff-only', rank: 1, trainingCutoff: RECENT });
    const undated = createModel({ name: 'aaa-undated', rank: 1 });

    // Both count as undated, so the tie falls through to the name.
    expect(names(sortModelsForPicker([cutoffOnly, undated]))).toEqual(['aaa-undated', 'cutoff-only']);
  });

  it('falls back to name so the order does not depend on catalog declaration order', () => {
    const b = createModel({ name: 'beta', rank: 1, releaseDate: STALE });
    const a = createModel({ name: 'alpha', rank: 1, releaseDate: STALE });

    expect(names(sortModelsForPicker([b, a]))).toEqual(['alpha', 'beta']);
  });

  it('does not mutate the input array', () => {
    const input = [createModel({ name: 'z', rank: 9 }), createModel({ name: 'a', rank: 1 })];
    sortModelsForPicker(input);

    expect(names(input)).toEqual(['z', 'a']);
  });
});
