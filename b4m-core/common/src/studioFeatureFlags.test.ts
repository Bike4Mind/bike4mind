import { describe, expect, it } from 'vitest';
import { settingsMap } from './schemas/settings';
import { STUDIO_FEATURE_FLAGS, isStudioFeatureOpen } from './studioFeatureFlags';

describe('STUDIO_FEATURE_FLAGS', () => {
  it.each(Object.values(STUDIO_FEATURE_FLAGS))('%s is a boolean admin setting that defaults off', key => {
    expect(settingsMap[key].defaultValue).toBe(false);
    expect(settingsMap[key].schema.parse(undefined)).toBe(false);
  });
});

describe('isStudioFeatureOpen', () => {
  it('opens only for an admin with the flag on', () => {
    expect(isStudioFeatureOpen({ isAdmin: true, flagEnabled: true })).toBe(true);
    expect(isStudioFeatureOpen({ isAdmin: true, flagEnabled: false })).toBe(false);
    expect(isStudioFeatureOpen({ isAdmin: false, flagEnabled: true })).toBe(false);
    expect(isStudioFeatureOpen({ isAdmin: false, flagEnabled: false })).toBe(false);
  });
});
