import { describe, expect, it } from 'vitest';
import { applyAccessChange, diffAccess, effectiveAccess, inverseAccessChange, isAdminsOnly } from './modelAccessChange';

describe('model access changes', () => {
  it('treats a model with no entry as on for everyone through base', () => {
    expect(effectiveAccess(null)).toEqual({
      enabled: true,
      allowedUserTags: [],
      allowedEntitlements: ['base'],
      fallbackModel: '',
      rank: null,
    });
  });

  it('diffs only the fields that moved, ignoring list order', () => {
    const before = effectiveAccess({ enabled: true, allowedUserTags: ['a', 'b'], allowedEntitlements: ['base'] });
    expect(diffAccess(before, { ...before, allowedUserTags: ['b', 'a'] })).toBeNull();
    expect(diffAccess(before, { ...before, rank: 3, fallbackModel: 'x' })).toEqual({ rank: 3, fallbackModel: 'x' });
  });

  it('inverts a change back to what it overwrote', () => {
    const before = effectiveAccess({ enabled: true, allowedUserTags: ['a'], allowedEntitlements: ['base'], rank: 4 });
    const change = { allowedUserTags: ['a', 'b'], rank: null };
    expect(inverseAccessChange(before, change)).toEqual({ allowedUserTags: ['a'], rank: 4 });
  });

  it('spots a change that leaves only admins able to see the model', () => {
    const before = effectiveAccess(null);
    expect(isAdminsOnly(applyAccessChange(before, { allowedEntitlements: [] }))).toBe(true);
    expect(isAdminsOnly(applyAccessChange(before, { allowedEntitlements: [], enabled: false }))).toBe(false);
  });
});
