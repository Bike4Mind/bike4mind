import { describe, expect, it } from 'vitest';
import {
  bulkAudienceSummary,
  bulkChangeOf,
  bulkDiffSummary,
  describeBulkEntry,
  MODEL_BULK_KINDS,
} from './modelBulkAccess';

const counts = { selected: 40, change: 37, unchanged: 3, noAudienceChange: 0, adminOnly: 0 };

describe('bulk access helpers', () => {
  it('builds the request change for each kind', () => {
    expect(bulkChangeOf('turn-off', [])).toEqual({ enabled: false });
    expect(bulkChangeOf('add-tag', [])).toBeNull();
    expect(bulkChangeOf('add-tag', ['beta'], true)).toEqual({ addTags: ['beta'], alsoRemoveBase: true });
    expect(bulkChangeOf('remove-tag', ['beta'], true)).toEqual({ removeTags: ['beta'] });
    expect(bulkChangeOf('remove-entitlement', ['pro'])).toEqual({ removeEntitlements: ['pro'] });
  });

  it('summarizes the dry run as how many models change and how many are already as asked', () => {
    expect(bulkDiffSummary('add-tag', ['beta'], counts)).toBe('Add tag beta: 37 change, 3 already have it');
    expect(bulkDiffSummary('turn-off', [], { ...counts, change: 12, unchanged: 5 })).toBe(
      'Turn off: 12 change, 5 already off'
    );
    expect(bulkDiffSummary('remove-tag', ['a', 'b'], counts)).toBe('Remove tag a, b: 37 change, 3 do not have them');
  });

  it('describes each changed model as before and after, defaulting a missing entry to base', () => {
    const after = { id: 'm', enabled: true, allowedUserTags: ['beta'], allowedEntitlements: [] };
    expect(describeBulkEntry({ before: null, after })).toBe('Tags: none \u2192 beta; Entitlements: base \u2192 none');
    expect(
      describeBulkEntry({
        before: { ...after, enabled: true, updatedAt: '2026-11-01T00:00:00.000Z' },
        after: { ...after, enabled: false },
      })
    ).toBe('On \u2192 Off');
  });

  it('puts Turn off last in the bulk bar', () => {
    expect(MODEL_BULK_KINDS.at(-1)).toBe('turn-off');
    expect(MODEL_BULK_KINDS[0]).toBe('turn-on');
  });

  it('counts who can pick the changed models afterwards, narrowest first', () => {
    const item = (audience: 'none' | 'wider' | 'narrower' | 'mixed', changes = true) => ({ audience, changes });
    expect(
      bulkAudienceSummary([item('none'), item('narrower'), item('narrower'), item('wider'), item('mixed', false)])
    ).toBe('Afterwards 2 reach fewer users, 1 reaches more users, 1 reaches the same users');
    expect(bulkAudienceSummary([item('wider', false)])).toBe('');
  });
});
