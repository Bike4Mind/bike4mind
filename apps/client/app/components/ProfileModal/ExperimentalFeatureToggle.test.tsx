import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
  updatePreferences.mockReset();
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

    expect(updatePreferences).toHaveBeenCalledWith({ contextTelemetryLevel: 'none' }, { rerunTelemetryDeletion: true });
  });

  it('leaves the export button in place regardless of the admin setting', () => {
    renderToggle();

    expect(screen.getByTestId('telemetry-export-btn')).toBeTruthy();
  });

  it('labels the export as telemetry and points content exports elsewhere', () => {
    renderToggle();

    expect(screen.getByTestId('telemetry-export-btn')).toHaveTextContent('Export telemetry data');
    expect(screen.queryByText('Export My Data')).toBeNull();
    expect(screen.getByTestId('telemetry-export-helper')).toHaveTextContent(
      'use Export All on the Notebooks and Knowledge Files cards'
    );
  });
});

describe('ExperimentalFeatureToggle telemetry deletion outcome', () => {
  const NONE_WITH_RERUN = [{ contextTelemetryLevel: 'none' }, { rerunTelemetryDeletion: true }];

  // The real context applies the level optimistically; the mock has to be told.
  const confirmStopAndDelete = () => {
    fireEvent.click(screen.getByTestId('telemetry-level-none'));
    fireEvent.click(screen.getByTestId('confirmation-confirm-btn'));
  };

  beforeEach(() => {
    userSettingsState.settings.contextTelemetryLevel = 'none';
  });

  it('shows no deletion notice before anything was requested', () => {
    renderToggle();

    expect(screen.queryByTestId('telemetry-deletion-incomplete')).toBeNull();
    expect(screen.queryByTestId('telemetry-deletion-complete')).toBeNull();
    expect(screen.queryByTestId('telemetry-deletion-pending')).toBeNull();
  });

  it('confirms the deletion once the server verified it', async () => {
    updatePreferences.mockResolvedValue({ telemetryDeletion: { verified: true, remainingCount: 0 } });
    renderToggle();

    confirmStopAndDelete();

    expect(await screen.findByTestId('telemetry-deletion-complete')).toHaveTextContent(
      'Your existing telemetry data was deleted.'
    );
    expect(screen.queryByTestId('telemetry-deletion-incomplete')).toBeNull();
  });

  it('tells the user when the deletion could not be confirmed and offers a retry', async () => {
    updatePreferences.mockResolvedValue({ telemetryDeletion: { verified: false, remainingCount: 2 } });
    renderToggle();

    confirmStopAndDelete();

    expect(await screen.findByTestId('telemetry-deletion-incomplete')).toHaveTextContent(
      'could not confirm that all of your existing telemetry data was deleted'
    );
    expect(screen.getByTestId('telemetry-deletion-retry-btn')).toHaveTextContent('Retry deletion');
    expect(screen.queryByTestId('telemetry-deletion-complete')).toBeNull();
  });

  it('re-runs the deletion from the retry action, without the confirmation step', async () => {
    updatePreferences.mockResolvedValueOnce({ telemetryDeletion: { verified: false, remainingCount: 2 } });
    updatePreferences.mockResolvedValueOnce({ telemetryDeletion: { verified: true, remainingCount: 0 } });
    renderToggle();
    confirmStopAndDelete();

    fireEvent.click(await screen.findByTestId('telemetry-deletion-retry-btn'));

    expect(await screen.findByTestId('telemetry-deletion-complete')).toBeTruthy();
    expect(screen.queryByTestId('telemetry-deletion-incomplete')).toBeNull();
    expect(updatePreferences.mock.calls).toEqual([NONE_WITH_RERUN, NONE_WITH_RERUN]);
  });

  it('keeps the retry action when the retry is incomplete as well', async () => {
    updatePreferences.mockResolvedValue({ telemetryDeletion: { verified: false } });
    renderToggle();
    confirmStopAndDelete();

    fireEvent.click(await screen.findByTestId('telemetry-deletion-retry-btn'));

    await waitFor(() => expect(updatePreferences).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('telemetry-deletion-retry-btn')).not.toBeDisabled();
    expect(screen.getByTestId('telemetry-deletion-incomplete')).toBeTruthy();
  });

  it('shows no deletion notice when the save itself did not land', async () => {
    updatePreferences.mockResolvedValue(undefined);
    renderToggle();

    confirmStopAndDelete();

    await waitFor(() => expect(screen.queryByTestId('telemetry-deletion-pending')).toBeNull());
    expect(screen.queryByTestId('telemetry-deletion-incomplete')).toBeNull();
    expect(screen.queryByTestId('telemetry-deletion-complete')).toBeNull();
  });

  it('clears the notice when the user picks a collecting level again', async () => {
    updatePreferences.mockResolvedValue({ telemetryDeletion: { verified: false, remainingCount: 2 } });
    const { rerender } = renderToggle();
    confirmStopAndDelete();
    await screen.findByTestId('telemetry-deletion-incomplete');

    fireEvent.click(screen.getByTestId('telemetry-level-basic'));
    userSettingsState.settings.contextTelemetryLevel = 'basic';
    rerender(
      <CssVarsProvider theme={appTheme}>
        <ExperimentalFeatureToggle />
      </CssVarsProvider>
    );

    expect(screen.queryByTestId('telemetry-deletion-incomplete')).toBeNull();
  });
});
