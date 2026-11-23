import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  isAdmin: false,
  tags: [] as string[],
  audience: undefined as string | undefined,
  entitlements: undefined as string[] | undefined,
  entitlementsError: false,
  entitlementsEnabled: [] as boolean[],
  enabledSettings: new Set<string>(),
  featuresLoading: false,
  authedSettingsLoaded: true,
  settingsError: null as string | null,
  signedIn: true,
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (state: { isAdmin: boolean; currentUser: { tags: string[] } }) => unknown) =>
    selector({ isAdmin: h.isAdmin, currentUser: { tags: h.tags } }),
}));
vi.mock('@client/app/hooks/data/entitlements', () => ({
  useEntitlements: ({ enabled }: { enabled: boolean }) => {
    h.entitlementsEnabled.push(enabled);
    return { data: enabled ? h.entitlements : undefined, isError: enabled && h.entitlementsError };
  },
}));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({
    isAdminFeatureEnabled: (key: string) => h.enabledSettings.has(key),
    isLoading: h.featuresLoading,
  }),
}));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({
    authedSettingsLoaded: h.authedSettingsLoaded,
    error: h.settingsError,
    getSetting: (key: string, fallback = '') =>
      key === 'StudioProductionsAudience' ? (h.audience ?? 'admins') : fallback,
  }),
}));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: (selector: (state: { accessToken: string | null }) => unknown) =>
    selector({ accessToken: h.signedIn ? 'token' : null }),
}));

import { useStudioFeature, useStudioFeatureAccess, useStudioFeaturesLoading } from './useStudioFeature';

beforeEach(() => {
  h.isAdmin = false;
  h.tags = [];
  h.audience = undefined;
  h.entitlements = undefined;
  h.entitlementsError = false;
  h.entitlementsEnabled = [];
  h.enabledSettings = new Set();
  h.featuresLoading = false;
  h.authedSettingsLoaded = true;
  h.settingsError = null;
  h.signedIn = true;
});

describe('useStudioFeature', () => {
  it('is closed by default, even for an admin', () => {
    h.isAdmin = true;
    expect(renderHook(() => useStudioFeature('image')).result.current).toBe(false);
  });

  it('opens Create v2 and Image to a non-admin when their settings are on', () => {
    h.enabledSettings = new Set(['EnableStudioCreateV2', 'EnableStudioImage']);
    expect(renderHook(() => useStudioFeature('createV2')).result.current).toBe(true);
    expect(renderHook(() => useStudioFeature('image')).result.current).toBe(true);
  });

  it('keeps Create v2 closed to a non-admin when its setting is off', () => {
    h.enabledSettings = new Set(['EnableStudioImage']);
    expect(renderHook(() => useStudioFeature('createV2')).result.current).toBe(false);
    expect(renderHook(() => useStudioFeature('image')).result.current).toBe(false);
  });

  it('keeps admin-only Productions closed to a non-admin with every setting on', () => {
    h.enabledSettings = new Set(['EnableStudioCreateV2', 'EnableStudioProductions']);
    expect(renderHook(() => useStudioFeature('productions')).result.current).toBe(false);
  });

  it('opens for an admin with that feature flag and Create v2 on, and only that feature', () => {
    h.isAdmin = true;
    h.enabledSettings = new Set(['EnableStudioCreateV2', 'EnableStudioImage']);
    expect(renderHook(() => useStudioFeature('image')).result.current).toBe(true);
    expect(renderHook(() => useStudioFeature('productions')).result.current).toBe(false);
  });

  it('keeps Image and Productions closed to an admin while Create v2 is off', () => {
    h.isAdmin = true;
    h.enabledSettings = new Set(['EnableStudioImage', 'EnableStudioProductions']);
    expect(renderHook(() => useStudioFeature('image')).result.current).toBe(false);
    expect(renderHook(() => useStudioFeature('productions')).result.current).toBe(false);
  });

  it('opens Create v2 alone without its children', () => {
    h.isAdmin = true;
    h.enabledSettings = new Set(['EnableStudioCreateV2']);
    expect(renderHook(() => useStudioFeature('createV2')).result.current).toBe(true);
    expect(renderHook(() => useStudioFeature('image')).result.current).toBe(false);
  });
});

describe('useStudioFeatureAccess for Productions', () => {
  const access = () => renderHook(() => useStudioFeatureAccess('productions')).result.current;

  beforeEach(() => {
    h.enabledSettings = new Set(['EnableStudioCreateV2', 'EnableStudioProductions']);
    h.audience = 'paid';
  });

  it('opens for a paid user and asks for upgrade for a free one', () => {
    h.entitlements = ['plan:paid'];
    expect(access()).toBe('open');
    h.entitlements = [];
    expect(access()).toBe('upgrade');
  });

  it('opens for an admin and a developer without loading entitlements', () => {
    h.isAdmin = true;
    expect(access()).toBe('open');
    h.isAdmin = false;
    h.tags = ['Developer'];
    expect(access()).toBe('open');
    expect(h.entitlementsEnabled.every(enabled => !enabled)).toBe(true);
  });

  it('does not treat a lookalike tag as developer', () => {
    h.tags = ['developer-ish'];
    h.entitlements = [];
    expect(access()).toBe('upgrade');
  });

  it('is closed with the flag off, whatever the plan', () => {
    h.enabledSettings = new Set(['EnableStudioCreateV2']);
    h.entitlements = ['plan:paid'];
    expect(access()).toBe('closed');
  });

  it('keeps the admins audience closed to a paid non-admin and loads no entitlements', () => {
    h.audience = 'admins';
    h.entitlements = ['plan:paid'];
    expect(access()).toBe('closed');
    expect(h.entitlementsEnabled.every(enabled => !enabled)).toBe(true);
  });

  it('falls back to admins for an unknown audience value', () => {
    h.audience = 'everyone';
    h.entitlements = ['plan:paid'];
    expect(access()).toBe('closed');
  });
});

describe('useStudioFeaturesLoading', () => {
  const loading = () => renderHook(() => useStudioFeaturesLoading()).result.current;

  it('is settled once settings, preferences and the authenticated fetch have all landed', () => {
    expect(loading()).toBe(false);
  });

  it('stays loading while user preferences or the first settings load are pending', () => {
    h.featuresLoading = true;
    expect(loading()).toBe(true);
  });

  it('stays loading for a signed-in user until the authenticated settings fetch lands, after public settings did', () => {
    h.authedSettingsLoaded = false;
    expect(loading()).toBe(true);
  });

  it('settles when the authenticated fetch fails, so a gate does not wait forever', () => {
    h.authedSettingsLoaded = false;
    h.settingsError = 'Failed to fetch admin settings';
    expect(loading()).toBe(false);
  });

  it('does not wait on the authenticated fetch when signed out', () => {
    h.authedSettingsLoaded = false;
    h.signedIn = false;
    expect(loading()).toBe(false);
  });

  describe('with a paid feature', () => {
    const loadingFor = () => renderHook(() => useStudioFeaturesLoading('productions')).result.current;

    beforeEach(() => {
      h.audience = 'paid';
    });

    it('waits for the entitlements of a free-tier viewer, so upgrade never flashes before a paying user is known', () => {
      expect(loadingFor()).toBe(true);
      h.entitlements = [];
      expect(loadingFor()).toBe(false);
    });

    it('settles when the entitlement read fails', () => {
      h.entitlementsError = true;
      expect(loadingFor()).toBe(false);
    });

    it('does not wait for an exempt viewer or a non-paid audience', () => {
      h.isAdmin = true;
      expect(loadingFor()).toBe(false);
      h.isAdmin = false;
      h.audience = 'admins';
      expect(loadingFor()).toBe(false);
    });

    it('does not wait on entitlements when no feature is asked about', () => {
      expect(loading()).toBe(false);
    });
  });
});
