import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  isAdmin: false,
  enabledSettings: new Set<string>(),
  featuresLoading: false,
  authedSettingsLoaded: true,
  settingsError: null as string | null,
  signedIn: true,
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (state: { isAdmin: boolean }) => unknown) => selector({ isAdmin: h.isAdmin }),
}));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({
    isAdminFeatureEnabled: (key: string) => h.enabledSettings.has(key),
    isLoading: h.featuresLoading,
  }),
}));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ authedSettingsLoaded: h.authedSettingsLoaded, error: h.settingsError }),
}));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: (selector: (state: { accessToken: string | null }) => unknown) =>
    selector({ accessToken: h.signedIn ? 'token' : null }),
}));

import { useStudioFeature, useStudioFeaturesLoading } from './useStudioFeature';

beforeEach(() => {
  h.isAdmin = false;
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

  it('stays closed to a non-admin when the flag is on', () => {
    h.enabledSettings = new Set(['EnableStudioImage']);
    expect(renderHook(() => useStudioFeature('image')).result.current).toBe(false);
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
});
