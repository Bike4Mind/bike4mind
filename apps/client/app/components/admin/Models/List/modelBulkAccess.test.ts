import { describe, expect, it } from 'vitest';
import { bulkChangeOf, bulkDiffSummary, describeBulkEntry } from './modelBulkAccess';

const counts = { selected: 40, change: 37, unchanged: 3, noAudienceChange: 0, adminOnly: 0 };

describe('bulk access helpers', () => {
  it('builds the request change for each kind', () => {
    expect(bulkChangeOf('turn-off', [], false)).toEqual({ enabled: false });
    expect(bulkChangeOf('add-tag', [], false)).toBeNull();
    expect(bulkChangeOf('add-tag', ['beta'], true)).toEqual({ addTags: ['beta'], alsoRemoveBase: true });
    expect(bulkChangeOf('remove-entitlement', ['pro'], false)).toEqual({ removeEntitlements: ['pro'] });
  });

  it('summarizes the dry run the way the spec words it', () => {
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
});
