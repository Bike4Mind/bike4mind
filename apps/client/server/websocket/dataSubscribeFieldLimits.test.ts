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

  it('does not exclude functionCalls.returnValue/error for the quests collection when the caller owns the session', () => {
    // A caller-owned quest subscription must not lose returnValue - the client cache merges a WS
    // update as a top-level spread, so ANY exclusion here replaces the owner's own cached tool
    // output the moment a live update lands, not just a sharee's.
    expect(resolveFieldLimits('quests', 'quests', true)).toBeUndefined();
  });

  it('still excludes functionCalls.returnValue/error for the quests collection when the caller is a sharee', () => {
    const limits = resolveFieldLimits('quests', 'quests', false);
    expect(limits).toEqual({
      'promptMeta.functionCalls.returnValue': false,
      'promptMeta.functionCalls.error': false,
    });
  });
});
