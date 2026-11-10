import { describe, expect, it } from 'vitest';
import { bulkChangeOf, bulkDiffSummary } from './modelBulkAccess';

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
});
