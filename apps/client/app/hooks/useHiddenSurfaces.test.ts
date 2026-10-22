import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { OPTI_SURFACE } from '@bike4mind/common';

let storeState: { currentUser: { preferences?: { hiddenSurfaces?: string[] } } | null } = { currentUser: null };
const mockUpdatePreferences = vi.fn((diff: { hiddenSurfaces?: string[] }) => {
  // Mirrors updatePreferences' write-through to the user store.
  storeState = { currentUser: { preferences: { ...storeState.currentUser?.preferences, ...diff } } };
});

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ updatePreferences: mockUpdatePreferences }),
}));

import { useHiddenSurfaces } from './useHiddenSurfaces';

const setStored = (hiddenSurfaces?: string[]) => {
  storeState = { currentUser: { preferences: hiddenSurfaces ? { hiddenSurfaces } : {} } };
};

describe('useHiddenSurfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setStored();
  });

  it('reports nothing hidden when the preference is unset', () => {
    const { result } = renderHook(() => useHiddenSurfaces());
    expect(result.current.hiddenSurfaces).toEqual([]);
    expect(result.current.isHidden(OPTI_SURFACE)).toBe(false);
  });

  it('reports a stored hidden surface', () => {
    setStored([OPTI_SURFACE]);
    const { result } = renderHook(() => useHiddenSurfaces());
    expect(result.current.isHidden(OPTI_SURFACE)).toBe(true);
  });

  it('writes the full list when hiding, without duplicating an id already present', () => {
    setStored(['other', OPTI_SURFACE]);
    const { result } = renderHook(() => useHiddenSurfaces());
    act(() => result.current.setHidden(OPTI_SURFACE, true));
    expect(mockUpdatePreferences).toHaveBeenCalledWith({ hiddenSurfaces: ['other', OPTI_SURFACE] });
  });

  it('shows the surface again when unhidden', () => {
    setStored([OPTI_SURFACE]);
    const { result, rerender } = renderHook(() => useHiddenSurfaces());
    act(() => result.current.setHidden(OPTI_SURFACE, false));
    expect(mockUpdatePreferences).toHaveBeenCalledWith({ hiddenSurfaces: [] });
    rerender();
    expect(result.current.isHidden(OPTI_SURFACE)).toBe(false);
  });

  it('ignores the main list and unregistered ids', () => {
    const { result } = renderHook(() => useHiddenSurfaces());
    act(() => {
      result.current.setHidden(null, true);
      result.current.setHidden('some-private-surface', true);
    });
    expect(mockUpdatePreferences).not.toHaveBeenCalled();
  });
});
