import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { VIDEO_MODEL_CATALOG, VIDEO_MODEL_IDS, type VideoGenerationSettings } from '@bike4mind/common';

const mutate = vi.fn();
let updatePending = false;
vi.mock('@client/app/hooks/data/settings', () => ({
  useUpdateSettings: () => ({ mutate, isPending: updatePending }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { AdminVideoModelsSetting } from './AdminVideoModelsSetting';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderSetting = (settings: VideoGenerationSettings | undefined) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <AdminVideoModelsSetting settings={settings} />
    </CssVarsProvider>
  );

const switchFor = (id: string) =>
  screen.getByTestId(`admin-video-models-${id}-switch`).querySelector('input') as HTMLInputElement;

const [firstId] = VIDEO_MODEL_IDS;
const defaultEnabled = VIDEO_MODEL_CATALOG[firstId].defaultEnabled;

describe('AdminVideoModelsSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updatePending = false;
  });

  it('renders one switch per catalog model with name and provider', () => {
    renderSetting({ enabledModels: {} });
    for (const id of VIDEO_MODEL_IDS) {
      expect(switchFor(id)).toBeTruthy();
      expect(screen.getByText(VIDEO_MODEL_CATALOG[id].displayName)).toBeTruthy();
    }
  });

  it('falls back to the catalog default when there is no override', () => {
    renderSetting({ enabledModels: {} });
    expect(switchFor(firstId).checked).toBe(defaultEnabled);
  });

  it('falls back to the catalog default when settings are not loaded yet', () => {
    renderSetting(undefined);
    expect(switchFor(firstId).checked).toBe(defaultEnabled);
  });

  it('honours an override of true', () => {
    renderSetting({ enabledModels: { [firstId]: true } });
    expect(switchFor(firstId).checked).toBe(true);
  });

  it('honours an override of false', () => {
    renderSetting({ enabledModels: { [firstId]: false } });
    expect(switchFor(firstId).checked).toBe(false);
  });

  it('saves the merged enabledModels when toggled', () => {
    renderSetting({ enabledModels: { 'other-model': true } });
    fireEvent.click(switchFor(firstId));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({
      key: 'videoGeneration',
      value: { enabledModels: { 'other-model': true, [firstId]: !defaultEnabled } },
    });
  });

  it('toasts on success and on failure', () => {
    renderSetting({ enabledModels: {} });
    fireEvent.click(switchFor(firstId));
    const options = mutate.mock.calls[0][1] as { onSuccess: () => void; onError: (error: Error) => void };
    options.onSuccess();
    expect(toast.success).toHaveBeenCalled();
    options.onError(new Error('boom'));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('disables the switches while a save is in flight', () => {
    updatePending = true;
    renderSetting({ enabledModels: {} });
    expect(switchFor(firstId).disabled).toBe(true);
  });

  it('notes a default-enabled model that has no override', () => {
    renderSetting({ enabledModels: {} });
    expect(screen.queryByTestId(`admin-video-models-${firstId}-default-note`) !== null).toBe(defaultEnabled);
  });
});
