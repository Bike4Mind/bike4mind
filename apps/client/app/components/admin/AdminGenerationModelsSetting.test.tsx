import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { MUSIC_MODEL_CATALOG, MUSIC_MODEL_IDS, VIDEO_MODEL_CATALOG, VIDEO_MODEL_IDS } from '@bike4mind/common';

const mutateAsync = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useBlocker: () => ({ status: 'idle' }),
  useRouter: () => ({
    state: { location: { pathname: '/admin', search: { tab: 'admin-settings' } } },
    navigate: vi.fn(),
  }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useUpdateSettings: () => ({ mutateAsync }),
}));
let storedSettings: Record<string, unknown> = {};
let authedSettingsLoaded = true;
vi.mock('@client/app/contexts/AdminSettingsContext', () => ({
  useAdminSettings: () => ({
    getSettingObject: (key: string, fallback: unknown) => storedSettings[key] ?? fallback,
    authedSettingsLoaded,
  }),
}));

import { AdminGenerationModelsSetting } from './AdminGenerationModelsSetting';
import { SettingsDraftProvider } from './SettingsDraftProvider';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderSetting = (settings: Record<string, unknown>) => {
  storedSettings = settings;
  return render(
    <CssVarsProvider theme={appTheme}>
      <SettingsDraftProvider>
        <AdminGenerationModelsSetting />
      </SettingsDraftProvider>
    </CssVarsProvider>
  );
};

type CatalogEntry = { displayName: string; defaultEnabled: boolean; preview?: boolean };
const MODALITIES: {
  modality: string;
  settingKey: string;
  ids: readonly string[];
  catalog: Record<string, CatalogEntry>;
}[] = [
  { modality: 'video', settingKey: 'videoGeneration', ids: VIDEO_MODEL_IDS, catalog: VIDEO_MODEL_CATALOG },
  { modality: 'music', settingKey: 'musicGeneration', ids: MUSIC_MODEL_IDS, catalog: MUSIC_MODEL_CATALOG },
];

beforeEach(() => {
  vi.clearAllMocks();
  mutateAsync.mockResolvedValue(undefined);
  authedSettingsLoaded = true;
});

describe.each(MODALITIES)(
  'AdminGenerationModelsSetting $modality section',
  ({ modality, settingKey, ids, catalog }) => {
    const switchFor = (id: string) =>
      screen.getByTestId(`admin-generation-models-${modality}-${id}-switch`).querySelector('input') as HTMLInputElement;
    const [firstId] = ids;
    const { defaultEnabled } = catalog[firstId];

    it('renders one switch per catalog model with its name', () => {
      renderSetting({});
      for (const id of ids) {
        expect(switchFor(id)).toBeTruthy();
        expect(screen.getAllByText(catalog[id].displayName).length).toBeGreaterThan(0);
      }
    });

    it('falls back to the catalog default when there is no override', () => {
      renderSetting({ [settingKey]: { enabledModels: {} } });
      expect(switchFor(firstId).checked).toBe(defaultEnabled);
    });

    it('falls back to the catalog default when settings are not loaded yet', () => {
      renderSetting({});
      expect(switchFor(firstId).checked).toBe(defaultEnabled);
    });

    it('falls back to the catalog default when the stored value is malformed', () => {
      renderSetting({ [settingKey]: { enabledModels: 'not-a-record' } });
      expect(switchFor(firstId).checked).toBe(defaultEnabled);
    });

    it.each([true, false])('honours an override of %s over the catalog default', override => {
      renderSetting({ [settingKey]: { enabledModels: { [firstId]: override } } });
      expect(switchFor(firstId).checked).toBe(override);
    });

    it('stages a toggle without writing, then saves the merged enabledModels from the SaveBar', async () => {
      renderSetting({ [settingKey]: { enabledModels: { 'other-model': true } } });
      fireEvent.click(switchFor(firstId));
      expect(switchFor(firstId).checked).toBe(!defaultEnabled);
      expect(mutateAsync).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
      expect(mutateAsync.mock.calls[0][0]).toEqual({
        key: settingKey,
        value: { enabledModels: { 'other-model': true, [firstId]: !defaultEnabled } },
      });
    });

    it('restores the stored value when the staged change is discarded', () => {
      renderSetting({});
      fireEvent.click(switchFor(firstId));
      fireEvent.click(screen.getByTestId('admin-save-discard-btn'));
      expect(switchFor(firstId).checked).toBe(defaultEnabled);
      expect(mutateAsync).not.toHaveBeenCalled();
    });

    it('keeps the staged toggle and shows the error when the save fails', async () => {
      mutateAsync.mockRejectedValue(new Error('Try again'));
      renderSetting({});
      fireEvent.click(switchFor(firstId));
      fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('was not saved: Try again'));
      expect(switchFor(firstId).checked).toBe(!defaultEnabled);
    });

    it('disables the switches until the stored settings have loaded', () => {
      authedSettingsLoaded = false;
      renderSetting({});
      expect(switchFor(firstId).disabled).toBe(true);
    });

    it('disables the switches while the SaveBar write is in flight', () => {
      mutateAsync.mockReturnValue(new Promise(() => {}));
      renderSetting({});
      fireEvent.click(switchFor(firstId));
      fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
      expect(switchFor(firstId).disabled).toBe(true);
    });

    it('throws when rendered outside a SettingsDraftProvider', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() =>
        render(
          <CssVarsProvider theme={appTheme}>
            <AdminGenerationModelsSetting />
          </CssVarsProvider>
        )
      ).toThrow('AdminGenerationModelsSetting must be rendered inside a SettingsDraftProvider.');
      error.mockRestore();
    });

    it('notes a default-enabled model only while it has no override', () => {
      const noteId = `admin-generation-models-${modality}-${firstId}-default-note`;
      const { unmount } = renderSetting({});
      expect(screen.queryByTestId(noteId) !== null).toBe(defaultEnabled);
      unmount();
      renderSetting({ [settingKey]: { enabledModels: { [firstId]: true } } });
      expect(screen.queryByTestId(noteId)).toBeNull();
    });

    it('marks preview models', () => {
      renderSetting({});
      for (const id of ids) {
        const chip = screen.queryByTestId(`admin-generation-models-${modality}-${id}-preview-chip`);
        expect(chip !== null).toBe(Boolean(catalog[id].preview));
      }
    });
  }
);

describe('AdminGenerationModelsSetting', () => {
  // Every first catalog entry is on by default, so this pins the off-by-default path of the shared helper.
  const offByDefault = MUSIC_MODEL_IDS.find(id => !MUSIC_MODEL_CATALOG[id].defaultEnabled);
  const musicSwitch = (id: string) =>
    screen.getByTestId(`admin-generation-models-music-${id}-switch`).querySelector('input') as HTMLInputElement;

  it('shows an off-by-default model as off, without the default note, and saves true when toggled', async () => {
    expect(offByDefault).toBeDefined();
    const id = offByDefault!;
    renderSetting({});
    expect(musicSwitch(id).checked).toBe(false);
    expect(screen.queryByTestId(`admin-generation-models-music-${id}-default-note`)).toBeNull();
    fireEvent.click(musicSwitch(id));
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toEqual({ key: 'musicGeneration', value: { enabledModels: { [id]: true } } });
  });

  it('shows a retired video model as off and locked, even under an override that enables it', () => {
    const retired = VIDEO_MODEL_IDS.find(id => VIDEO_MODEL_CATALOG[id].retired);
    expect(retired).toBeDefined();
    const id = retired!;
    renderSetting({ videoGeneration: { enabledModels: { [id]: true } } });
    const input = screen
      .getByTestId(`admin-generation-models-video-${id}-switch`)
      .querySelector('input') as HTMLInputElement;
    expect(input.checked).toBe(false);
    expect(input.disabled).toBe(true);
    expect(screen.getByTestId(`admin-generation-models-video-${id}-retired-chip`)).toBeTruthy();
  });

  it('keeps the two settings independent', async () => {
    const [videoId] = VIDEO_MODEL_IDS;
    const [musicId] = MUSIC_MODEL_IDS;
    renderSetting({ videoGeneration: { enabledModels: { [videoId]: false } } });
    fireEvent.click(
      screen.getByTestId(`admin-generation-models-music-${musicId}-switch`).querySelector('input') as HTMLInputElement
    );
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toEqual({
      key: 'musicGeneration',
      value: { enabledModels: { [musicId]: !MUSIC_MODEL_CATALOG[musicId].defaultEnabled } },
    });
  });
});
