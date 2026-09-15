import { describe, it, expect, vi } from 'vitest';

// The migration module pulls in the model barrel at import time; only the pure selector is tested.
vi.mock('@bike4mind/database', () => ({ SystemPrompt: {}, safeDropIndex: vi.fn() }));

import {
  selectSupersededDuplicates,
  type LiveSystemPromptRow,
} from './20260731100000_fix-systemprompt-live-unique-index';

const row = (over: Partial<LiveSystemPromptRow> & { _id: string }): LiveSystemPromptRow => ({
  promptId: 'p1',
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

describe('selectSupersededDuplicates', () => {
  it('returns nothing when every promptId is unique', () => {
    expect(selectSupersededDuplicates([row({ _id: 'a' }), row({ _id: 'b', promptId: 'p2' })])).toEqual([]);
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

  it('dedupes each promptId independently', () => {
    const rows = [
      row({ _id: 'p1-old', updatedAt: new Date('2026-01-01T00:00:00Z') }),
      row({ _id: 'p1-new', updatedAt: new Date('2026-02-01T00:00:00Z') }),
      row({ _id: 'p2-only', promptId: 'p2' }),
    ];

    expect(selectSupersededDuplicates(rows)).toEqual(['p1-old']);
  });
});
