import { describe, it, expect } from 'vitest';
import { resolveCheckedAt } from './resolveCheckedAt';

const now = new Date('2026-06-01T12:00:00.000Z');

describe('resolveCheckedAt', () => {
  it('uses finishedAt when it is in the past', () => {
    expect(resolveCheckedAt('2026-05-31T00:00:00.000Z', '2026-05-30T00:00:00.000Z', now)).toEqual(
      new Date('2026-05-31T00:00:00.000Z')
    );
  });

  it('falls back to startedAt when finishedAt is missing or unparsable', () => {
    const expected = new Date('2026-05-30T00:00:00.000Z');
    expect(resolveCheckedAt(undefined, '2026-05-30T00:00:00.000Z', now)).toEqual(expected);
    expect(resolveCheckedAt('nope', '2026-05-30T00:00:00.000Z', now)).toEqual(expected);
  });

  it('uses now when neither timestamp parses', () => {
    expect(resolveCheckedAt(undefined, undefined, now)).toEqual(now);
    expect(resolveCheckedAt('nope', 'also nope', now)).toEqual(now);
  });

  it('clamps future timestamps to now', () => {
    expect(resolveCheckedAt('2099-01-01T00:00:00.000Z', undefined, now)).toEqual(now);
    expect(resolveCheckedAt(undefined, '2099-01-01T00:00:00.000Z', now)).toEqual(now);
  });
});
