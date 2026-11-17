import { describe, expect, it } from 'vitest';
import { settingsMap, userReadableSettingKeys } from './schemas/settings';
import {
  STUDIO_FEATURE_AUDIENCE,
  STUDIO_FEATURE_FLAGS,
  STUDIO_FEATURE_PARENT,
  isStudioFeatureOpen,
  isStudioFeatureVisibleTo,
  studioFeatureSettingKeys,
  type StudioFeature,
} from './studioFeatureFlags';

describe('STUDIO_FEATURE_FLAGS', () => {
  it.each(Object.values(STUDIO_FEATURE_FLAGS))('%s is a boolean admin setting that defaults off', key => {
    expect(settingsMap[key].defaultValue).toBe(false);
    expect(settingsMap[key].schema.parse(undefined)).toBe(false);
  });

  // useStudioFeature reads these through GET /api/settings/fetch, which serves a non-admin only these keys.
  it.each(Object.values(STUDIO_FEATURE_FLAGS))('%s is readable by a non-admin client', key => {
    expect(userReadableSettingKeys()).toContain(key);
  });
});

describe('STUDIO_FEATURE_AUDIENCE', () => {
  it('opens Create v2 and Image to everyone and keeps Productions admin-only', () => {
    expect(STUDIO_FEATURE_AUDIENCE).toEqual({ createV2: 'everyone', image: 'everyone', productions: 'admins' });
  });

  it.each(Object.keys(STUDIO_FEATURE_FLAGS) as StudioFeature[])(
    '%s is open to everyone only if its parent is',
    feature => {
      const parent = STUDIO_FEATURE_PARENT[feature];
      if (parent && STUDIO_FEATURE_AUDIENCE[feature] === 'everyone') {
        expect(STUDIO_FEATURE_AUDIENCE[parent]).toBe('everyone');
      }
    }
  );
});

describe('isStudioFeatureOpen', () => {
  it.each(['createV2', 'image'] as const)('lets the setting alone decide %s, for admins and non-admins', feature => {
    expect(isStudioFeatureOpen({ feature, isAdmin: true, flagEnabled: true })).toBe(true);
    expect(isStudioFeatureOpen({ feature, isAdmin: false, flagEnabled: true })).toBe(true);
    expect(isStudioFeatureOpen({ feature, isAdmin: true, flagEnabled: false })).toBe(false);
    expect(isStudioFeatureOpen({ feature, isAdmin: false, flagEnabled: false })).toBe(false);
  });

  it('opens Productions only for an admin with the flag on', () => {
    expect(isStudioFeatureOpen({ feature: 'productions', isAdmin: true, flagEnabled: true })).toBe(true);
    expect(isStudioFeatureOpen({ feature: 'productions', isAdmin: true, flagEnabled: false })).toBe(false);
    expect(isStudioFeatureOpen({ feature: 'productions', isAdmin: false, flagEnabled: true })).toBe(false);
    expect(isStudioFeatureVisibleTo('productions', false)).toBe(false);
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
