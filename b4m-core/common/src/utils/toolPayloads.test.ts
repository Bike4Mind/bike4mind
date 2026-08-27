import { describe, it, expect } from 'vitest';
import { toToolPayloads } from './toolPayloads';

describe('toToolPayloads', () => {
  it('projects each persisted side-effect to the public {type,payload} shape', () => {
    const problem = { name: 'shop', jobs: [], machines: [] };
    expect(toToolPayloads([{ type: 'populateProblem', payload: problem }])).toEqual([
      { type: 'populateProblem', payload: problem },
    ]);
  });

  it('emits ONLY type and payload, so a Mongoose subdocument _id never reaches the API', () => {
    const entry = { _id: '507f1f77bcf86cd799439011', type: 'populateProblem', payload: { name: 'shop' } };
    expect(Object.keys(toToolPayloads([entry])[0])).toEqual(['type', 'payload']);
  });

  it('preserves emission order (a caller walking multi-step output depends on it)', () => {
    const out = toToolPayloads([
      { type: 'populateProblem', payload: { step: 1 } },
      { type: 'populateScheduleRace', payload: { step: 2 } },
      { type: 'populateDecomposition', payload: { step: 3 } },
    ]);
    expect(out.map(p => p.type)).toEqual(['populateProblem', 'populateScheduleRace', 'populateDecomposition']);
  });

  it('returns [] for a turn that fired no structured tool', () => {
    expect(toToolPayloads(undefined)).toEqual([]);
    expect(toToolPayloads(null)).toEqual([]);
    expect(toToolPayloads([])).toEqual([]);
  });

  it('drops malformed entries without discarding the well-formed ones around them', () => {
    const out = toToolPayloads([
      { type: 'populateProblem', payload: { keep: 'first' } },
      { payload: { orphan: true } }, // no type: caller cannot tell what shape this is
      { type: 'populateProblem' }, // no payload: nothing to act on
      { type: 'populateProblem', payload: null },
      { type: 42, payload: { bad: 'type' } } as unknown as { type: unknown; payload: unknown },
      { type: 'populateFamilyProblem', payload: { keep: 'last' } },
    ]);
    expect(out).toEqual([
      { type: 'populateProblem', payload: { keep: 'first' } },
      { type: 'populateFamilyProblem', payload: { keep: 'last' } },
    ]);
  });

  it('passes a non-object payload through (the type discriminator owns the shape contract)', () => {
    expect(toToolPayloads([{ type: 'populateProblem', payload: 'opaque' }])).toEqual([
      { type: 'populateProblem', payload: 'opaque' },
    ]);
  });

  it('does not mutate the persisted array', () => {
    const stored = [{ type: 'populateProblem', payload: { name: 'shop' } }];
    toToolPayloads(stored);
    expect(stored).toEqual([{ type: 'populateProblem', payload: { name: 'shop' } }]);
  });
});
