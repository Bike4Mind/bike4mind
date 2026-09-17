import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';

const updatePreferences = vi.fn();

let userSettingsState: {
  settings: {
    contextTelemetryLevel: 'none' | 'basic' | 'enhanced';
    agentModeDefault: 'off' | 'auto' | 'on';
    experimentalFeatures: Record<string, boolean>;
  };
  updatePreferences: typeof updatePreferences;
};

let serverSettingsState: { data: Array<{ settingName: string; settingValue: string }>; isLoading: boolean };

vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => userSettingsState,
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'user-1', isAdmin: false } }),
}));

vi.mock('@client/app/hooks/data/settings', () => ({
  useExperimentalFeatureSettings: () => serverSettingsState,
}));

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({
    isFeatureEnabled: (feature: string) => userSettingsState.settings.experimentalFeatures?.[feature] ?? false,
  }),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));

import ExperimentalFeatureToggle from './ExperimentalFeatureToggle';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderToggle = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ExperimentalFeatureToggle />
    </CssVarsProvider>
  );

const withAdminTelemetry = (enabled: boolean) => {
  serverSettingsState = {
    data: [{ settingName: 'EnableContextTelemetry', settingValue: enabled ? 'true' : 'false' }],
    isLoading: false,
  };
};

beforeEach(() => {
  updatePreferences.mockClear();
  userSettingsState = {
    settings: { contextTelemetryLevel: 'basic', agentModeDefault: 'off', experimentalFeatures: {} },
    updatePreferences,
  };
  withAdminTelemetry(false);
});

describe('ExperimentalFeatureToggle telemetry level control', () => {
  it('keeps the level buttons enabled when the admin setting is off', () => {
    renderToggle();

    expect(screen.getByTestId('telemetry-level-none')).not.toBeDisabled();
    expect(screen.getByTestId('telemetry-level-basic')).not.toBeDisabled();
    expect(screen.getByTestId('telemetry-level-enhanced')).not.toBeDisabled();
  });

  it('still lets the user change their own level when admin sharing is off', () => {
    renderToggle();

    fireEvent.click(screen.getByTestId('telemetry-level-enhanced'));

    expect(updatePreferences).toHaveBeenCalledWith({ contextTelemetryLevel: 'enhanced' });
  });

  it('tells the user sharing is off while making clear their own view is unaffected', () => {
    renderToggle();

    const notice = screen.getByText(/Sharing with us is off/);
    expect(notice.textContent).toMatch(/context breakdown for your own messages/);
  });

  it('does not show the admin notice when sharing is enabled', () => {
    withAdminTelemetry(true);
    renderToggle();

    expect(screen.queryByText(/Sharing with us is off/)).toBeNull();
  });

  it('still confirms before turning telemetry off, without applying the change immediately', () => {
    renderToggle();

    fireEvent.click(screen.getByTestId('telemetry-level-none'));

    expect(updatePreferences).not.toHaveBeenCalled();
    expect(screen.getByText('Stop Telemetry Collection')).toBeTruthy();

    fireEvent.click(screen.getByTestId('confirmation-confirm-btn'));

    expect(updatePreferences).toHaveBeenCalledWith({ contextTelemetryLevel: 'none' });
  });

  it('leaves the export button in place regardless of the admin setting', () => {
    renderToggle();

    expect(screen.getByTestId('telemetry-export-btn')).toBeTruthy();
  });
});
