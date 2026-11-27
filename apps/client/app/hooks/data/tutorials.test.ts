import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const state = vi.hoisted(() => ({ settings: [] as { settingName: string; settingValue: unknown }[] }));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useServerSettings: () => ({ serverSettings: state.settings }),
}));

import { useTutorialsEnabled, type TutorialsEnabledOptions } from './tutorials';

const on = (settingName: string, settingValue: unknown = true) => ({ settingName, settingValue });
const enabled = (options?: TutorialsEnabledOptions) => renderHook(() => useTutorialsEnabled(options)).result.current;

describe('useTutorialsEnabled', () => {
  beforeEach(() => {
    state.settings = [];
  });

  it("is off while core's switch is unset", () => {
    expect(enabled()).toBe(false);
  });

  it("is on once core's switch is on, as a boolean or a string", () => {
    state.settings = [on('EnableCoreTutorials')];
    expect(enabled()).toBe(true);
    state.settings = [on('EnableCoreTutorials', 'true')];
    expect(enabled()).toBe(true);
  });

  it('stays off with the switch off', () => {
    state.settings = [on('EnableCoreTutorials', 'false')];
    expect(enabled()).toBe(false);
  });

  it('asks every setting a host names, and the access check it passes', () => {
    const options = { settings: ['HostFeature', 'HostTutorials'] };
    state.settings = [on('HostFeature'), on('HostTutorials')];
    expect(enabled({ ...options, hasAccess: true })).toBe(true);
    expect(enabled({ ...options, hasAccess: false })).toBe(false);
    state.settings = [on('HostTutorials')];
    expect(enabled({ ...options, hasAccess: true })).toBe(false);
  });
});
