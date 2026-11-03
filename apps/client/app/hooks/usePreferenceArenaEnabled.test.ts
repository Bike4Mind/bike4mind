import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePreferenceArenaEnabled } from './usePreferenceArenaEnabled';

const state = vi.hoisted(() => ({ isSuccess: true, value: undefined as unknown }));
vi.mock('@client/app/hooks/data/settings', () => ({
  useSettingsFromServer: () => ({ isSuccess: state.isSuccess }),
  useGetSettingsValue: () => state.value,
}));

describe('usePreferenceArenaEnabled', () => {
  beforeEach(() => {
    state.isSuccess = true;
    state.value = undefined;
  });

  it.each([
    ['the string true', 'true', true],
    ['boolean true', true, true],
    ['the string false', 'false', false],
    ['boolean false', false, false],
    ['unset', undefined, false],
  ])('with %s -> %s', (_label, value, expected) => {
    state.value = value;
    expect(renderHook(() => usePreferenceArenaEnabled()).result.current).toBe(expected);
  });

  it('is false until the settings have loaded', () => {
    state.isSuccess = false;
    state.value = 'true';
    expect(renderHook(() => usePreferenceArenaEnabled()).result.current).toBe(false);
  });
});
