import { describe, it, expect } from 'vitest';
import { isShadowTier, throttleSourceForSignal } from './throttleTier';

const shadow = { tier: 'shadow' as const };

describe('isShadowTier', () => {
  it('is true for a shadow user', () => {
    expect(isShadowTier({ throttle: shadow })).toBe(true);
  });

  it('is false for tier none, null, or absent', () => {
    expect(isShadowTier({ throttle: { tier: 'none' } })).toBe(false);
    expect(isShadowTier({ throttle: null })).toBe(false);
    expect(isShadowTier({})).toBe(false);
  });

  it('is false for a null or undefined user', () => {
    expect(isShadowTier(null)).toBe(false);
    expect(isShadowTier(undefined)).toBe(false);
  });

  it('is false for admins and developer-tagged users', () => {
    expect(isShadowTier({ isAdmin: true, throttle: shadow })).toBe(false);
    expect(isShadowTier({ tags: ['Developer'], throttle: shadow })).toBe(false);
    expect(isShadowTier({ tags: ['Customer'], throttle: shadow })).toBe(true);
  });
});

describe('throttleSourceForSignal', () => {
  it('maps signals to sources', () => {
    expect(throttleSourceForSignal('signup_honeypot')).toBe('signup_honeypot');
    expect(throttleSourceForSignal('signup_too_fast')).toBe('signup_timing');
    expect(throttleSourceForSignal('signup_token_missing')).toBe('signup_timing');
    expect(throttleSourceForSignal('signup_token_invalid')).toBe('signup_timing');
    expect(throttleSourceForSignal('signup_token_expired')).toBe('signup_timing');
  });
});
