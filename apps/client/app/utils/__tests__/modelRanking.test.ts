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
  it('ranks a curated admin rank above a model that only just launched', () => {
    const curatedDefault = createModel({ name: 'curated', rank: 0, releaseDate: STALE });
    const justLaunched = createModel({ name: 'launched', rank: 50, releaseDate: RECENT });

    expect(names(sortModelsForPicker([curatedDefault, justLaunched]))).toEqual(['curated', 'launched']);
  });

  it('gives an unranked model a provisional rank instead of an automatic top slot', () => {
    const ranked = createModel({ name: 'ranked', rank: 4, releaseDate: STALE });
    const unrankedButNew = createModel({ name: 'unrelated-new', releaseDate: RECENT });

    // No shared family, so 'unrelated-new' falls back to the type-section median (4,
    // the only ranked model present) instead of auto-topping the list for being new.
    // That ties it with 'ranked' on effective rank, so date - not newness - decides.
    expect(names(sortModelsForPicker([ranked, unrankedButNew]))).toEqual(['unrelated-new', 'ranked']);
  });

  it('keeps rank ahead of release date - the regression this comparator fixes', () => {
    // The reported bug: a new mid-tier release used to jump above its own provider's
    // frontier model merely for being newer. Rank must decide this pair, not date.
    const newestButLowerRank = createModel({ name: 'newest', rank: 1, releaseDate: RECENT });
    const olderTopRank = createModel({ name: 'older', rank: 0, releaseDate: OLDER_RECENT });

    expect(names(sortModelsForPicker([olderTopRank, newestButLowerRank]))).toEqual(['older', 'newest']);
  });

  it('orders models with the same release date by rank', () => {
    const sameDayRank1 = createModel({ name: 'rank1', rank: 1, releaseDate: RECENT });
    const sameDayRank0 = createModel({ name: 'rank0', rank: 0, releaseDate: RECENT });

    expect(names(sortModelsForPicker([sameDayRank1, sameDayRank0]))).toEqual(['rank0', 'rank1']);
  });

  it('respects admin rank', () => {
    const rank5 = createModel({ name: 'rank5', rank: 5, releaseDate: STALE });
    const rank1 = createModel({ name: 'rank1', rank: 1, releaseDate: STALE });

    expect(names(sortModelsForPicker([rank5, rank1]))).toEqual(['rank1', 'rank5']);
  });

  it("gives an unranked model its family cohort's rank rather than sinking it to the bottom", () => {
    const ranked = createModel({ name: 'Atlas One', rank: 3, releaseDate: STALE });
    const unranked = createModel({ name: 'Atlas Two', releaseDate: STALE }); // shares the 'Atlas' cohort

    // 'Atlas Two' inherits the cohort's only rank (3) and ties with 'Atlas One' on
    // effective rank; every later tiebreak (date, generation) also ties, so name decides.
    expect(names(sortModelsForPicker([ranked, unranked]))).toEqual(['Atlas One', 'Atlas Two']);
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

  it('breaks a tie between unranked, undated models by derived generation', () => {
    const pointRelease = createModel({ name: 'Nimbus 4.5' });
    const flagship = createModel({ name: 'Nimbus 4' });
    const olderGen = createModel({ name: 'Nimbus 3 Mini' });

    // Nothing here has a rank or a release date, so both tie; the trailing version
    // number in the name decides, newest generation first - mirrors the real xAI
    // section (Grok 4.5, Grok 4, Grok 3 Mini), which has no ranked text model either.
    expect(names(sortModelsForPicker([olderGen, flagship, pointRelease]))).toEqual([
      'Nimbus 4.5',
      'Nimbus 4',
      'Nimbus 3 Mini',
    ]);
  });

  it('reads the version from the leading number, not a trailing parameter count', () => {
    const newer = createModel({ name: 'Llama 4 Maverick 17B Instruct' });
    const older = createModel({ name: 'Llama 3 Instruct 70B' });

    // The trailing number is a parameter count. Reading it would rank the 70B older
    // generation above the newer one.
    expect(names(sortModelsForPicker([older, newer]))).toEqual([
      'Llama 4 Maverick 17B Instruct',
      'Llama 3 Instruct 70B',
    ]);
  });

  it('does not read a trailing snapshot date as a version', () => {
    // Discovery names an introduced model by its raw id, and no feed may supply rank or
    // releaseDate (both presentation), so such a model reaches the generation tiebreak.
    const datedId = createModel({ name: 'claude-sonnet-5-20260401' });
    const newerGeneration = createModel({ name: 'Claude 6 Opus' });

    expect(names(sortModelsForPicker([datedId, newerGeneration]))).toEqual([
      'Claude 6 Opus',
      'claude-sonnet-5-20260401',
    ]);
  });

  it('takes the family cohort median as the provisional rank, not the minimum', () => {
    const best = createModel({ name: 'Comet Prime', rank: 0, releaseDate: STALE });
    const mid = createModel({ name: 'Comet Core', rank: 4, releaseDate: STALE });
    const worst = createModel({ name: 'Comet Lite', rank: 9, releaseDate: STALE });
    const unranked = createModel({ name: 'Comet Nova', releaseDate: RECENT }); // new; same 'Comet' cohort

    // Cohort ranks sorted are [0, 4, 9] -> index floor(3/2) = 1 -> median 4. A minimum
    // would let the new release claim rank 0 and jump straight to the top instead.
    const result = sortModelsForPicker([best, mid, worst, unranked]);
    expect(names(result)).toEqual(['Comet Prime', 'Comet Nova', 'Comet Core', 'Comet Lite']);
  });

  it('falls back to the type-section median when no family cohort matches', () => {
    const rankedA = createModel({ name: 'Alpha One', rank: 2, releaseDate: STALE });
    const rankedB = createModel({ name: 'Beta One', rank: 6, releaseDate: STALE });
    const rankedC = createModel({ name: 'Gamma One', rank: 10, releaseDate: STALE });
    const orphan = createModel({ name: 'Zephyr Nova', releaseDate: STALE }); // no ranked model starts with 'zephyr'

    // Section ranks sorted are [2, 6, 10] -> median 6, tying 'Zephyr Nova' with 'Beta One'.
    const result = sortModelsForPicker([rankedA, rankedB, rankedC, orphan]);
    expect(names(result)).toEqual(['Alpha One', 'Beta One', 'Zephyr Nova', 'Gamma One']);
  });

  it('does not borrow a provisional rank from another type section', () => {
    // The picker sorts a whole backend group at once, mixing text and image models whose
    // rank scales are unrelated (OpenAI's images sit at 8-11, its text at 0-4). An image
    // rank leaking into a text model's median would sink every newly discovered text model.
    const image = createModel({ name: 'Prism One', type: 'image', rank: 10, releaseDate: STALE });
    const text = createModel({ name: 'Prism Two', rank: 1, releaseDate: STALE });
    const newText = createModel({ name: 'Prism Three', releaseDate: STALE });

    // 'Prism Three' shares the 'Prism' cohort with both, but only the text row counts,
    // so it inherits 1 rather than the 1-and-10 median of 10.
    expect(names(sortModelsForPicker([image, text, newText]))).toEqual(['Prism Three', 'Prism Two', 'Prism One']);
  });

  it('uses rank 1 as the last resort when nothing in the section has a rank', () => {
    const a = createModel({ name: 'Solo Alpha', releaseDate: STALE });
    const b = createModel({ name: 'Solo Beta', releaseDate: RECENT });

    expect(names(sortModelsForPicker([a, b]))).toEqual(['Solo Beta', 'Solo Alpha']);
  });

  it('does not mutate the input array', () => {
    const input = [createModel({ name: 'z', rank: 9 }), createModel({ name: 'a' })];
    sortModelsForPicker(input);

    expect(names(input)).toEqual(['z', 'a']);
  });
});
