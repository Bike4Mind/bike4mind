import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock('./data/settings', () => ({
  useGetSettingsValue: (key: string) => h.values[key],
  useSettingsFromServer: () => ({
    data: Object.entries(h.values).map(([settingName, settingValue]) => ({ settingName, settingValue })),
  }),
}));
import { useSignupGrantCredits } from './useSignupGrantCredits';

describe('signup grant copy configuration', () => {
  beforeEach(() => {
    h.values = { defaultFreeCredits: 37, signupGrantCredits: 12, stagedSignupGrantEnabled: false };
  });
  it('preserves the installed legacy amount when staging is disabled', () => {
    expect(renderHook(useSignupGrantCredits).result.current).toBe(37);
  });
  it('parses persisted string booleans explicitly', () => {
    h.values.stagedSignupGrantEnabled = 'false';
    expect(renderHook(useSignupGrantCredits).result.current).toBe(37);
    h.values.stagedSignupGrantEnabled = 'true';
    expect(renderHook(useSignupGrantCredits).result.current).toBe(12);
  });
  it('reads the signup tranche instead of advertising the full grant', () => {
    h.values.stagedSignupGrantEnabled = true;
    expect(renderHook(useSignupGrantCredits).result.current).toBe(12);
  });
  it('does not advertise credits when the configured tranche is zero', () => {
    h.values.stagedSignupGrantEnabled = true;
    h.values.signupGrantCredits = 0;
    expect(renderHook(useSignupGrantCredits).result.current).toBe(0);
  });
  it.each([undefined, null])('uses the server legacy fallback when the signup setting is %j', signup => {
    h.values.stagedSignupGrantEnabled = true;
    h.values.signupGrantCredits = signup;
    expect(renderHook(useSignupGrantCredits).result.current).toBe(37);
  });
  it.each(['', ' ', -1, 1.5, Infinity, 'invalid'])(
    'treats an invalid configured tranche %j as unset, like the server',
    signup => {
      h.values.stagedSignupGrantEnabled = true;
      h.values.signupGrantCredits = signup;
      expect(renderHook(useSignupGrantCredits).result.current).toBe(37);
    }
  );
  it('prefers the initial credits key over the old tranche key, honouring an explicit 0', () => {
    h.values.stagedSignupGrantEnabled = true;
    h.values.signupGrantInitialCredits = '500';
    expect(renderHook(useSignupGrantCredits).result.current).toBe(500);
    h.values.signupGrantInitialCredits = '0';
    expect(renderHook(useSignupGrantCredits).result.current).toBe(0);
  });
});
