import { describe, it, expect, vi } from 'vitest';

// The migration module pulls in the model barrel at import time; only the pure selector is tested.
vi.mock('@bike4mind/database', () => ({ LatticeModel: {}, safeDropIndex: vi.fn() }));

import { selectSupersededDuplicates, type LiveLatticeRow } from './20260813000100_fix-lattice-live-unique-name-index';

const row = (over: Partial<LiveLatticeRow> & { _id: string }): LiveLatticeRow => ({
  userId: 'u1',
  name: 'Budget',
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

describe('selectSupersededDuplicates (lattice)', () => {
  it('returns nothing when every (userId, name) is unique', () => {
    expect(selectSupersededDuplicates([row({ _id: 'a' }), row({ _id: 'b', name: 'Forecast' })])).toEqual([]);
  });

  it('keeps the most recently updated duplicate and supersedes the rest', () => {
    const rows = [
      row({ _id: 'old', updatedAt: new Date('2026-01-01T00:00:00Z') }),
      row({ _id: 'newest', updatedAt: new Date('2026-03-01T00:00:00Z') }),
      row({ _id: 'middle', updatedAt: new Date('2026-02-01T00:00:00Z') }),
    ];

    expect(selectSupersededDuplicates(rows)).toEqual(['old', 'middle']);
  });

  it('falls back to createdAt when updatedAt is missing', () => {
    const rows = [
      row({ _id: 'newer', updatedAt: null, createdAt: new Date('2026-02-01T00:00:00Z') }),
      row({ _id: 'older', updatedAt: null, createdAt: new Date('2026-01-01T00:00:00Z') }),
    ];

    expect(selectSupersededDuplicates(rows)).toEqual(['older']);
  });

  it('treats a row with no timestamps as the oldest', () => {
    const rows = [row({ _id: 'undated', updatedAt: null, createdAt: null }), row({ _id: 'dated' })];

    expect(selectSupersededDuplicates(rows)).toEqual(['undated']);
  });

  it('scopes uniqueness per user: the same name under different users is not a duplicate', () => {
    const rows = [row({ _id: 'u1', userId: 'u1' }), row({ _id: 'u2', userId: 'u2' })];

    expect(selectSupersededDuplicates(rows)).toEqual([]);
  });

  it('dedupes each (userId, name) group independently', () => {
    const rows = [
      row({ _id: 'a-old', updatedAt: new Date('2026-01-01T00:00:00Z') }),
      row({ _id: 'a-new', updatedAt: new Date('2026-02-01T00:00:00Z') }),
      row({ _id: 'b-only', name: 'Forecast' }),
    ];

    expect(selectSupersededDuplicates(rows)).toEqual(['a-old']);
  });
});
