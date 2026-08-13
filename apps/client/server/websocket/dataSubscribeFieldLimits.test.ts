import { describe, it, expect } from 'vitest';
import { resolveFieldLimits } from './dataSubscribeFieldLimits';

describe('resolveFieldLimits', () => {
  it('excludes functionCalls.returnValue/error for the quests collection', () => {
    const limits = resolveFieldLimits('quests', 'quests');
    expect(limits).toEqual({
      'promptMeta.functionCalls.returnValue': false,
      'promptMeta.functionCalls.error': false,
    });
  });

  it('excludes password/stripeCustomerId/resetPasswordToken for the users collection', () => {
    const limits = resolveFieldLimits('users', 'quests');
    expect(limits).toEqual({ password: false, stripeCustomerId: false, resetPasswordToken: false });
  });

  it('returns undefined for a collection with no configured limits', () => {
    expect(resolveFieldLimits('projects', 'quests')).toBeUndefined();
  });

  it('uses the passed-in quest collection name rather than a hardcoded literal', () => {
    // Guards against a future rename of the Quest collection silently breaking this exclusion.
    const limits = resolveFieldLimits('chathistoryitems', 'chathistoryitems');
    expect(limits).toBeDefined();
  });
});
