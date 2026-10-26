import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DISCOVERY_COOLDOWN_MS,
  DISCOVERY_PRIORITY,
  EMPTY_DISCOVERY_STATE,
  discoveryCandidates,
  pickDiscoveryGears,
  readDiscoveryState,
  shouldShowDiscovery,
  writeDiscoveryState,
} from './discovery';

const g = (key: string, unlocked = false, claimed = false) => ({ key, unlocked, claimed });
const NOW = Date.UTC(2026, 9, 26);

describe('discoveryCandidates', () => {
  it('drops used gears, unlocked or claimed', () => {
    expect(discoveryCandidates([g('agents', true), g('files', false, true), g('image')]).map(x => x.key)).toEqual([
      'image',
    ]);
  });

  it('orders by DISCOVERY_PRIORITY and appends unknown keys in input order', () => {
    const keys = discoveryCandidates([g('zzz-new'), g('image'), g('aaa-new'), g('models')]).map(x => x.key);
    expect(keys).toEqual(['models', 'image', 'zzz-new', 'aaa-new']);
  });

  it('starts with the most valuable gears', () => {
    expect(DISCOVERY_PRIORITY.slice(0, 3)).toEqual(['models', 'agents', 'projects']);
  });
});

describe('pickDiscoveryGears', () => {
  const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

  it('returns everything when there are 3 or fewer', () => {
    expect(pickDiscoveryGears(['a', 'b', 'c'], 10)).toEqual(['a', 'b', 'c']);
  });

  it('takes 3 starting at the rotation offset, wrapping', () => {
    expect(pickDiscoveryGears(seven, 0)).toEqual(['a', 'b', 'c']);
    expect(pickDiscoveryGears(seven, 6)).toEqual(['g', 'a', 'b']);
    expect(pickDiscoveryGears(seven, 10)).toEqual(['d', 'e', 'f']);
  });
});

describe('shouldShowDiscovery', () => {
  const base = { state: EMPTY_DISCOVERY_STATE, candidateCount: 3, now: NOW };

  it('shows when never shown before', () => {
    expect(shouldShowDiscovery(base)).toBe(true);
  });

  it('shows with a single candidate but not with none', () => {
    expect(shouldShowDiscovery({ ...base, candidateCount: 1 })).toBe(true);
    expect(shouldShowDiscovery({ ...base, candidateCount: 0 })).toBe(false);
  });

  it('respects the 1-day cooldown', () => {
    const state = { ...EMPTY_DISCOVERY_STATE, lastShownAt: NOW - DISCOVERY_COOLDOWN_MS + 1 };
    expect(shouldShowDiscovery({ ...base, state })).toBe(false);
    expect(shouldShowDiscovery({ ...base, state: { ...state, lastShownAt: NOW - DISCOVERY_COOLDOWN_MS } })).toBe(true);
  });

  it('treats a lastShownAt in the future as never shown', () => {
    const state = { ...EMPTY_DISCOVERY_STATE, lastShownAt: NOW + 30 * DISCOVERY_COOLDOWN_MS };
    expect(shouldShowDiscovery({ ...base, state })).toBe(true);
  });

  it('never shows once dismissed', () => {
    expect(shouldShowDiscovery({ ...base, state: { ...EMPTY_DISCOVERY_STATE, dismissed: true } })).toBe(false);
  });
});

describe('discovery storage', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('round-trips per user', () => {
    writeDiscoveryState('u1', { lastShownAt: 5, dismissed: true, rotation: 10 });
    expect(readDiscoveryState('u1')).toEqual({ lastShownAt: 5, dismissed: true, rotation: 10 });
    expect(readDiscoveryState('u2')).toEqual(EMPTY_DISCOVERY_STATE);
  });

  it('treats malformed values as empty, field by field', () => {
    localStorage.setItem('gears_discovery_u1', 'not json');
    expect(readDiscoveryState('u1')).toEqual(EMPTY_DISCOVERY_STATE);
    localStorage.setItem('gears_discovery_u1', '[1,2]');
    expect(readDiscoveryState('u1')).toEqual(EMPTY_DISCOVERY_STATE);
    localStorage.setItem('gears_discovery_u1', JSON.stringify({ lastShownAt: 'x', dismissed: 'yes', rotation: -3 }));
    expect(readDiscoveryState('u1')).toEqual(EMPTY_DISCOVERY_STATE);
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readDiscoveryState('u1')).toEqual(EMPTY_DISCOVERY_STATE);
    expect(() => writeDiscoveryState('u1', EMPTY_DISCOVERY_STATE)).not.toThrow();
  });
});
