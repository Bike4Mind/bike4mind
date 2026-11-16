import { describe, expect, it } from 'vitest';
import {
  MODEL_UNAVAILABLE_CODE,
  describePickedFor,
  rankCandidates,
  type ModelStanding,
  type RankingCandidate,
} from './modelRanking';

const fits = (id: string, pickedFor: string[] = [id]): RankingCandidate<string> => ({ id, mismatch: null, pickedFor });
const standings: Record<string, ModelStanding> = {
  oldFlagship: { tier: 'flagship', releasedAt: '2025-04-23', preview: false },
  newFlagship: { tier: 'flagship', releasedAt: '2026-09-08', preview: false },
  newStandard: { tier: 'standard', releasedAt: '2026-10-01', preview: false },
  newestFast: { tier: 'fast', releasedAt: '2026-11-01', preview: false },
  previewFlagship: { tier: 'flagship', releasedAt: '2026-11-10', preview: true },
};
const standingOf = (id: string): ModelStanding | undefined => standings[id];
const noStanding = (): undefined => undefined;

const mismatch = (id: string): RankingCandidate<string> => ({
  id,
  mismatch: { code: 'unsupported_aspect_ratio', reason: `${id} takes no aspect ratio.` },
  pickedFor: [],
});

describe('rankCandidates', () => {
  it('puts models that fit first, then mismatches, then unavailable ones', () => {
    const ranked = rankCandidates([mismatch('m'), fits('u'), fits('f')], noStanding, {
      unavailable: { u: 'Not wired.' },
    });
    expect(ranked.map(model => [model.id, model.status])).toEqual([
      ['f', 'fits'],
      ['m', 'mismatch'],
      ['u', 'unavailable'],
    ]);
    expect(ranked[2].whyNot).toEqual({ code: MODEL_UNAVAILABLE_CODE, reason: 'Not wired.' });
    expect(ranked[2].pickedFor).toEqual([]);
  });

  it('orders within a group: generally available first, then flagship tier, then newest release', () => {
    const ids = ['previewFlagship', 'newestFast', 'oldFlagship', 'newStandard', 'newFlagship'];
    const ranked = rankCandidates(
      ids.map(id => fits(id)),
      standingOf
    );
    expect(ranked.map(model => model.id)).toEqual([
      'newFlagship',
      'oldFlagship',
      'newStandard',
      'newestFast',
      'previewFlagship',
    ]);
  });

  it('ranks an id with no standing after every known one, then keeps the caller order', () => {
    const ranked = rankCandidates([fits('x'), fits('newestFast'), fits('y'), fits('oldFlagship')], standingOf);
    expect(ranked.map(model => model.id)).toEqual(['oldFlagship', 'newestFast', 'x', 'y']);
  });

  it('never lets standing lift a model over a better fit status', () => {
    const ranked = rankCandidates([mismatch('newFlagship'), fits('newestFast')], standingOf);
    expect(ranked.map(model => model.id)).toEqual(['newestFast', 'newFlagship']);
  });

  it('keeps the validator code and reason on a mismatch and drops its picked-for reasons', () => {
    const [ranked] = rankCandidates([{ ...mismatch('m'), pickedFor: ['ignored'] }], noStanding);
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
    expect(rankCandidates(candidates, standingOf)).toEqual(rankCandidates(candidates, standingOf));
    expect(candidates).toEqual(snapshot);
  });
});

describe('describePickedFor', () => {
  it('joins the reasons into the Picked for line', () => {
    expect(describePickedFor(['product photoreal', 'reference'])).toBe('product photoreal + reference');
    expect(describePickedFor([])).toBe('');
  });
});
