import { describe, it, expect } from 'vitest';
import { resolveFieldLimits, type FieldLimitOptions } from './dataSubscribeFieldLimits';

const opts = (overrides: Partial<FieldLimitOptions> = {}): FieldLimitOptions => ({
  questCollectionName: 'quests',
  organizationCollectionName: 'organizations',
  ...overrides,
});

describe('resolveFieldLimits', () => {
  it('excludes functionCalls.returnValue/error for the quests collection', () => {
    const limits = resolveFieldLimits('quests', opts());
    expect(limits).toEqual({
      'promptMeta.functionCalls.returnValue': false,
      'promptMeta.functionCalls.error': false,
    });
  });

  it('excludes password/stripeCustomerId/resetPasswordToken for the users collection', () => {
    const limits = resolveFieldLimits('users', opts());
    expect(limits).toEqual({ password: false, stripeCustomerId: false, resetPasswordToken: false });
  });

  it('returns undefined for a collection with no configured limits', () => {
    expect(resolveFieldLimits('projects', opts())).toBeUndefined();
  });

  it('uses the passed-in quest collection name rather than a hardcoded literal', () => {
    // Guards against a future rename of the Quest collection silently breaking this exclusion.
    const limits = resolveFieldLimits('chathistoryitems', opts({ questCollectionName: 'chathistoryitems' }));
    expect(limits).toBeDefined();
  });

  it('does not exclude functionCalls.returnValue/error for the quests collection when the caller owns the session', () => {
    // A caller-owned quest subscription must not lose returnValue - the client cache merges a WS
    // update as a top-level spread, so ANY exclusion here replaces the owner's own cached tool
    // output the moment a live update lands, not just a sharee's.
    expect(resolveFieldLimits('quests', opts({ isQuestOwner: true }))).toBeUndefined();
  });

  it('still excludes functionCalls.returnValue/error for the quests collection when the caller is a sharee', () => {
    const limits = resolveFieldLimits('quests', opts({ isQuestOwner: false }));
    expect(limits).toEqual({
      'promptMeta.functionCalls.returnValue': false,
      'promptMeta.functionCalls.error': false,
    });
  });

  it('excludes stripeCustomerId and billingContact for a non-admin organizations subscriber', () => {
    expect(resolveFieldLimits('organizations', opts())).toEqual({
      stripeCustomerId: false,
      billingContact: false,
    });
  });

  it('still excludes stripeCustomerId for a platform admin, who keeps billingContact', () => {
    // Mirrors toSafeOrganization: stripeCustomerId has no client consumer at all, billingContact
    // is privileged. Owners are NOT privileged here - see the projection note in the source.
    expect(resolveFieldLimits('organizations', opts({ isPlatformAdmin: true }))).toEqual({
      stripeCustomerId: false,
    });
  });

  it('uses the passed-in organization collection name rather than a hardcoded literal', () => {
    expect(resolveFieldLimits('orgs_v2', opts({ organizationCollectionName: 'orgs_v2' }))).toEqual({
      stripeCustomerId: false,
      billingContact: false,
    });
  });
});
