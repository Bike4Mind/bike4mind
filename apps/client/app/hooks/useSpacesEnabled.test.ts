import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ loaded: false, on: false, error: null as Error | null }));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({
    authedSettingsLoaded: h.loaded,
    error: h.error,
    isFeatureEnabled: (key: string) => key === 'EnableSpaces' && h.on,
  }),
}));

import { useSpacesEnabled } from './useSpacesEnabled';

beforeEach(() => {
  h.loaded = false;
  h.on = false;
  h.error = null;
});

describe('useSpacesEnabled', () => {
  it('is not ready and not enabled before authed settings load, even if the default reads on', () => {
    h.on = true;
    const { result } = renderHook(() => useSpacesEnabled());
    expect(result.current).toEqual({ ready: false, enabled: false });
  });

  it('is ready but disabled with the flag off', () => {
    h.loaded = true;
    const { result } = renderHook(() => useSpacesEnabled());
    expect(result.current).toEqual({ ready: true, enabled: false });
  });

  it('is ready but disabled when the authed settings fetch fails', () => {
    h.error = new Error('settings failed');
    const { result } = renderHook(() => useSpacesEnabled());
    expect(result.current).toEqual({ ready: true, enabled: false });
  });

  it('is enabled with the flag on once loaded', () => {
    h.loaded = true;
    h.on = true;
    const { result } = renderHook(() => useSpacesEnabled());
    expect(result.current).toEqual({ ready: true, enabled: true });
  });
});
