import { describe, expect, it } from 'vitest';
import { isLaneMarked, laneMetadata } from './lane';

describe('laneMetadata', () => {
  it('marks a synthetic user with the synthetic lane, over every other flag', () => {
    expect(laneMetadata({ isSynthetic: true })).toEqual({ lane: 'synthetic' });
    expect(laneMetadata({ isSynthetic: true, isInternal: true, isAdmin: true })).toEqual({ lane: 'synthetic' });
  });

  it('marks an internal account or an admin internal', () => {
    expect(laneMetadata({ isInternal: true })).toEqual({ internal: true });
    expect(laneMetadata({ isAdmin: true })).toEqual({ internal: true });
    expect(laneMetadata({ isSynthetic: false, isInternal: true, isAdmin: false })).toEqual({ internal: true });
  });

  it('marks no one else, and never sends a false mark', () => {
    expect(laneMetadata({ isSynthetic: false, isInternal: false, isAdmin: false })).toEqual({});
    expect(laneMetadata({ isSynthetic: null, isInternal: null, isAdmin: null })).toEqual({});
    expect(laneMetadata({})).toEqual({});
    expect(laneMetadata(null)).toEqual({});
    expect(laneMetadata(undefined)).toEqual({});
  });

  it('reads only a literal true, so a truthy non-boolean stored value marks nothing', () => {
    const odd = { isSynthetic: 'yes', isInternal: 1, isAdmin: 'true' } as unknown as Parameters<typeof laneMetadata>[0];
    expect(laneMetadata(odd)).toEqual({});
  });
});

describe('isLaneMarked', () => {
  it('is true for either mark and false for an unmarked account', () => {
    expect(isLaneMarked({ isSynthetic: true })).toBe(true);
    expect(isLaneMarked({ isInternal: true })).toBe(true);
    expect(isLaneMarked({ isAdmin: true })).toBe(true);
    expect(isLaneMarked({ isSynthetic: false, isInternal: false, isAdmin: false })).toBe(false);
    expect(isLaneMarked(undefined)).toBe(false);
  });
});
