import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { MUSIC_MODEL_CATALOG, MUSIC_MODEL_IDS, VIDEO_MODEL_CATALOG, VIDEO_MODEL_IDS } from '@bike4mind/common';

const mutate = vi.fn();
let updatePending = false;
// Sections call useUpdateSettings in render order (video, then music); null applies updatePending to both.
let pendingSection: 'video' | 'music' | null = null;
let updateHookCalls = 0;
vi.mock('@client/app/hooks/data/settings', () => ({
  useUpdateSettings: () => {
    const section = updateHookCalls++ % 2 === 0 ? 'video' : 'music';
    return { mutate, isPending: pendingSection ? pendingSection === section : updatePending };
  },
}));
let storedSettings: Record<string, unknown> = {};
let authedSettingsLoaded = true;
vi.mock('@client/app/contexts/AdminSettingsContext', () => ({
  useAdminSettings: () => ({
    getSettingObject: (key: string, fallback: unknown) => storedSettings[key] ?? fallback,
    authedSettingsLoaded,
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
  pendingSection = null;
  updateHookCalls = 0;
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

    it('disables the switches until the stored settings have loaded', () => {
      authedSettingsLoaded = false;
      renderSetting({});
      expect(switchFor(firstId).disabled).toBe(true);
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
  // Every first catalog entry is on by default, so this pins the off-by-default path of the shared helper.
  const offByDefault = MUSIC_MODEL_IDS.find(id => !MUSIC_MODEL_CATALOG[id].defaultEnabled);
  const musicSwitch = (id: string) =>
    screen.getByTestId(`admin-generation-models-music-${id}-switch`).querySelector('input') as HTMLInputElement;

  it('shows an off-by-default model as off, without the default note, and saves true when toggled', () => {
    expect(offByDefault).toBeDefined();
    const id = offByDefault!;
    renderSetting({});
    expect(musicSwitch(id).checked).toBe(false);
    expect(screen.queryByTestId(`admin-generation-models-music-${id}-default-note`)).toBeNull();
    fireEvent.click(musicSwitch(id));
    expect(mutate.mock.calls[0][0]).toEqual({ key: 'musicGeneration', value: { enabledModels: { [id]: true } } });
  });

  it.each(['video', 'music'] as const)('locks only the %s section while its save is in flight', pending => {
    pendingSection = pending;
    renderSetting({});
    const firstSwitch = (modality: string, id: string) =>
      screen.getByTestId(`admin-generation-models-${modality}-${id}-switch`).querySelector('input') as HTMLInputElement;
    expect(firstSwitch('video', VIDEO_MODEL_IDS[0]).disabled).toBe(pending === 'video');
    expect(firstSwitch('music', MUSIC_MODEL_IDS[0]).disabled).toBe(pending === 'music');
  });

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
