import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  isAdmin: false,
  enabledSettings: new Set<string>(),
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (state: { isAdmin: boolean }) => unknown) => selector({ isAdmin: h.isAdmin }),
}));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isAdminFeatureEnabled: (key: string) => h.enabledSettings.has(key) }),
}));

import { useStudioFeature } from './useStudioFeature';

beforeEach(() => {
  h.isAdmin = false;
  h.enabledSettings = new Set();
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
