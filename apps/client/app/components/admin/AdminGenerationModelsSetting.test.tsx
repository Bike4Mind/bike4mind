import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { MUSIC_MODEL_CATALOG, MUSIC_MODEL_IDS, VIDEO_MODEL_CATALOG, VIDEO_MODEL_IDS } from '@bike4mind/common';

const mutate = vi.fn();
let updatePending = false;
vi.mock('@client/app/hooks/data/settings', () => ({
  useUpdateSettings: () => ({ mutate, isPending: updatePending }),
}));
let storedSettings: Record<string, unknown> = {};
vi.mock('@client/app/contexts/AdminSettingsContext', () => ({
  useAdminSettings: () => ({
    getSettingObject: (key: string, fallback: unknown) => storedSettings[key] ?? fallback,
  }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { AdminGenerationModelsSetting } from './AdminGenerationModelsSetting';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderSetting = (settings: Record<string, unknown>) => {
  storedSettings = settings;
  return render(
    <CssVarsProvider theme={appTheme}>
      <AdminGenerationModelsSetting />
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
  updatePending = false;
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

    it('saves the merged enabledModels under its own setting key when toggled', () => {
      renderSetting({ [settingKey]: { enabledModels: { 'other-model': true } } });
      fireEvent.click(switchFor(firstId));
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(mutate.mock.calls[0][0]).toEqual({
        key: settingKey,
        value: { enabledModels: { 'other-model': true, [firstId]: !defaultEnabled } },
      });
    });

    it('toasts on success and on failure', () => {
      renderSetting({});
      fireEvent.click(switchFor(firstId));
      const options = mutate.mock.calls[0][1] as { onSuccess: () => void; onError: (error: Error) => void };
      options.onSuccess();
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining(catalog[firstId].displayName));
      options.onError(new Error('boom'));
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining(`${modality} generation models: boom`));
    });

    it('disables the switches while a save is in flight', () => {
      updatePending = true;
      renderSetting({});
      expect(switchFor(firstId).disabled).toBe(true);
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
  it('keeps the two settings independent', () => {
    const [videoId] = VIDEO_MODEL_IDS;
    const [musicId] = MUSIC_MODEL_IDS;
    renderSetting({ videoGeneration: { enabledModels: { [videoId]: false } } });
    fireEvent.click(
      screen.getByTestId(`admin-generation-models-music-${musicId}-switch`).querySelector('input') as HTMLInputElement
    );
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({
      key: 'musicGeneration',
      value: { enabledModels: { [musicId]: !MUSIC_MODEL_CATALOG[musicId].defaultEnabled } },
    });
  });
});
