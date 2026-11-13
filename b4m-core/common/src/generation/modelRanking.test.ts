import { describe, expect, it } from 'vitest';
import { MODEL_UNAVAILABLE_CODE, describePickedFor, rankCandidates, type RankingCandidate } from './modelRanking';

const fits = (id: string, pickedFor: string[] = [id]): RankingCandidate<string> => ({ id, mismatch: null, pickedFor });
const mismatch = (id: string): RankingCandidate<string> => ({
  id,
  mismatch: { code: 'unsupported_aspect_ratio', reason: `${id} takes no aspect ratio.` },
  pickedFor: [],
});

describe('rankCandidates', () => {
  it('puts models that fit first, then mismatches, then unavailable ones', () => {
    const ranked = rankCandidates([mismatch('m'), fits('u'), fits('f')], [], { unavailable: { u: 'Not wired.' } });
    expect(ranked.map(model => [model.id, model.status])).toEqual([
      ['f', 'fits'],
      ['m', 'mismatch'],
      ['u', 'unavailable'],
    ]);
    expect(ranked[2].whyNot).toEqual({ code: MODEL_UNAVAILABLE_CODE, reason: 'Not wired.' });
    expect(ranked[2].pickedFor).toEqual([]);
  });

  it('orders within a group by preference, then by the caller order', () => {
    const ranked = rankCandidates([fits('x'), fits('b'), fits('y'), fits('a')], ['a', 'b']);
    expect(ranked.map(model => model.id)).toEqual(['a', 'b', 'x', 'y']);
  });

  it('keeps the validator code and reason on a mismatch and drops its picked-for reasons', () => {
    const [ranked] = rankCandidates([{ ...mismatch('m'), pickedFor: ['ignored'] }], []);
    expect(ranked).toEqual({
      id: 'm',
      status: 'mismatch',
      pickedFor: [],
      whyNot: { code: 'unsupported_aspect_ratio', reason: 'm takes no aspect ratio.' },
    });
  });

  it('is deterministic and does not mutate its input', () => {
    const candidates = [fits('c'), mismatch('b'), fits('a')];
    const snapshot = structuredClone(candidates);
    expect(rankCandidates(candidates, ['a'])).toEqual(rankCandidates(candidates, ['a']));
    expect(candidates).toEqual(snapshot);
  });
});

describe('describePickedFor', () => {
  it('joins the reasons into the Picked for line', () => {
    expect(describePickedFor(['product photoreal', 'reference'])).toBe('product photoreal + reference');
    expect(describePickedFor([])).toBe('');
  });
});
