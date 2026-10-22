import { describe, expect, it } from 'vitest';
import { settingsMap } from './schemas/settings';
import {
  STUDIO_FEATURE_FLAGS,
  STUDIO_FEATURE_PARENT,
  isStudioFeatureOpen,
  studioFeatureSettingKeys,
  type StudioFeature,
} from './studioFeatureFlags';

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

describe('studioFeatureSettingKeys', () => {
  it('needs only its own setting for Create v2', () => {
    expect(studioFeatureSettingKeys('createV2')).toEqual(['EnableStudioCreateV2']);
  });

  it.each(['image', 'productions'] as const)('needs Create v2 as well as its own setting for %s', feature => {
    expect(studioFeatureSettingKeys(feature)).toEqual(['EnableStudioCreateV2', STUDIO_FEATURE_FLAGS[feature]]);
  });

  it.each(Object.keys(STUDIO_FEATURE_FLAGS) as StudioFeature[])(
    "%s declares the parent's setting as dependsOn, matching STUDIO_FEATURE_PARENT",
    feature => {
      const parent = STUDIO_FEATURE_PARENT[feature];
      const entry: { dependsOn?: string } = settingsMap[STUDIO_FEATURE_FLAGS[feature]];
      expect(entry.dependsOn).toBe(parent ? STUDIO_FEATURE_FLAGS[parent] : undefined);
    }
  );
});
