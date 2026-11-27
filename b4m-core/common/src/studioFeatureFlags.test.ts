import { describe, expect, it } from 'vitest';
import { settingsMap, userReadableSettingKeys } from './schemas/settings';
import {
  STUDIO_FEATURE_AUDIENCE,
  STUDIO_FEATURE_FLAGS,
  STUDIO_FEATURE_PARENT,
  STUDIO_FEATURE_AUDIENCE_SETTING,
  resolveStudioFeatureAccess,
  studioFeatureAudience,
  studioFeatureSettingKeys,
  type StudioFeature,
  type StudioFeatureAudience,
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

describe('studioFeatureAudience', () => {
  it('reads the audience setting for Productions', () => {
    expect(studioFeatureAudience('productions', 'paid')).toBe('paid');
    expect(studioFeatureAudience('productions', 'admins')).toBe('admins');
  });

  it.each([undefined, null, '', 'everyone', 'PAID', 42])('falls back to admins for the unknown value %s', value => {
    expect(studioFeatureAudience('productions', value)).toBe('admins');
  });

  it.each(['createV2', 'image'] as const)('ignores a setting value for %s, which has no audience setting', feature => {
    expect(studioFeatureAudience(feature, 'paid')).toBe('everyone');
  });

  it('backs every overridable feature with a string setting that defaults to admins', () => {
    for (const key of Object.values(STUDIO_FEATURE_AUDIENCE_SETTING)) {
      expect(settingsMap[key!].defaultValue).toBe('admins');
      expect(settingsMap[key!].schema.safeParse('paid').success).toBe(true);
      expect(settingsMap[key!].schema.safeParse('everyone').success).toBe(false);
    }
  });
});

describe('resolveStudioFeatureAccess', () => {
  const viewers = {
    admin: { isAdmin: true, tags: [] as string[], paid: false },
    developer: { isAdmin: false, tags: ['Developer'], paid: false },
    paid: { isAdmin: false, tags: [] as string[], paid: true },
    free: { isAdmin: false, tags: ['developer-ish'], paid: false },
  };
  const table: Record<StudioFeatureAudience, Record<keyof typeof viewers, 'open' | 'upgrade' | 'closed'>> = {
    everyone: { admin: 'open', developer: 'open', paid: 'open', free: 'open' },
    paid: { admin: 'open', developer: 'open', paid: 'open', free: 'upgrade' },
    admins: { admin: 'open', developer: 'closed', paid: 'closed', free: 'closed' },
  };

  it.each(Object.keys(table) as StudioFeatureAudience[])('resolves the %s audience for each viewer', audience => {
    for (const [name, v] of Object.entries(viewers) as [keyof typeof viewers, (typeof viewers)['admin']][]) {
      expect(
        resolveStudioFeatureAccess({
          viewer: { isAdmin: v.isAdmin, tags: v.tags },
          hasPaidPlan: v.paid,
          flagEnabled: true,
          audience,
        }),
        `${audience}/${name}`
      ).toBe(table[audience][name]);
    }
  });

  it.each(Object.keys(table) as StudioFeatureAudience[])('closes %s for everyone when the flag is off', audience => {
    for (const v of Object.values(viewers)) {
      expect(
        resolveStudioFeatureAccess({
          viewer: { isAdmin: v.isAdmin, tags: v.tags },
          hasPaidPlan: v.paid,
          flagEnabled: false,
          audience,
        })
      ).toBe('closed');
    }
  });

  it('treats missing tags and a null isAdmin as a free viewer', () => {
    const base = { hasPaidPlan: false, flagEnabled: true, audience: 'paid' as const };
    expect(resolveStudioFeatureAccess({ ...base, viewer: { isAdmin: null, tags: null } })).toBe('upgrade');
    expect(resolveStudioFeatureAccess({ ...base, viewer: {} })).toBe('upgrade');
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
