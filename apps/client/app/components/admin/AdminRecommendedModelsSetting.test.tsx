import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ModelInfo } from '@bike4mind/common';

const mutate = vi.fn();
vi.mock('@client/app/hooks/data/settings', () => ({
  useUpdateSettings: () => ({ mutate, isPending: false }),
}));
const stored = vi.hoisted(() => ({ ids: undefined as unknown, defaultModel: undefined as string | undefined }));
vi.mock('@client/app/contexts/AdminSettingsContext', () => ({
  useAdminSettings: () => ({
    getSetting: (key: string, fallback = '') =>
      key === 'DefaultAPIModel' ? (stored.defaultModel ?? fallback) : fallback,
    getSettingObject: (_key: string, fallback: unknown) => stored.ids ?? fallback,
  }),
}));
const models = vi.hoisted(() => [
  { id: 'model-a', name: 'Model A', type: 'text' },
  { id: 'model-b', name: 'Model B', type: 'text' },
  { id: 'model-c', name: 'Model C', type: 'text' },
]);
vi.mock('@client/app/hooks/useAccessibleModels', () => ({
  useAccessibleModels: () => ({ accessibleTextModels: models as ModelInfo[], isLoading: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AdminRecommendedModelsSetting } from './AdminRecommendedModelsSetting';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderEditor = (ids: unknown, defaultModel?: string) => {
  stored.ids = ids;
  stored.defaultModel = defaultModel;
  return render(
    <CssVarsProvider theme={appTheme}>
      <AdminRecommendedModelsSetting />
    </CssVarsProvider>
  );
};

const rowIds = () =>
  screen
    .getAllByTestId(/^admin-recommended-models-row-/)
    .map(row => row.getAttribute('data-testid')!.replace('admin-recommended-models-row-', ''));
const saveBtn = () => screen.getByTestId('admin-recommended-models-save-btn') as HTMLButtonElement;

describe('AdminRecommendedModelsSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the stored ids in order with display names, Save disabled until an edit', () => {
    renderEditor(['model-b', 'model-a']);
    expect(rowIds()).toEqual(['model-b', 'model-a']);
    expect(within(screen.getByTestId('admin-recommended-models-row-model-b')).getByText('Model B')).toBeTruthy();
    expect(saveBtn().disabled).toBe(true);
  });

  it('names the default model the picker falls back to when the list is empty', () => {
    renderEditor([], 'model-c');
    expect(screen.getByTestId('admin-recommended-models-empty').textContent).toContain('Model C');
  });

  it('keeps an id no longer in the model list, marked unavailable and removable', () => {
    renderEditor(['retired-model', 'model-a']);
    expect(rowIds()).toEqual(['retired-model', 'model-a']);
    expect(screen.getByTestId('admin-recommended-models-retired-model-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('admin-recommended-models-model-a-unavailable')).toBeNull();

    fireEvent.click(screen.getByTestId('admin-recommended-models-retired-model-remove-btn'));
    expect(rowIds()).toEqual(['model-a']);
  });

  it('adds a model from the list to the end', () => {
    renderEditor(['model-a']);
    fireEvent.click(screen.getByTestId('admin-recommended-models-add-select'));
    // Already-listed models are not offered again.
    expect(screen.queryByTestId('admin-recommended-models-option-model-a')).toBeNull();
    fireEvent.click(screen.getByTestId('admin-recommended-models-option-model-c'));
    expect(rowIds()).toEqual(['model-a', 'model-c']);
  });

  it('reorders with the up and down buttons, disabling them at the ends', () => {
    renderEditor(['model-a', 'model-b', 'model-c']);
    expect((screen.getByTestId('admin-recommended-models-model-a-up-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('admin-recommended-models-model-c-down-btn') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('admin-recommended-models-model-c-up-btn'));
    expect(rowIds()).toEqual(['model-a', 'model-c', 'model-b']);
    fireEvent.click(screen.getByTestId('admin-recommended-models-model-a-down-btn'));
    expect(rowIds()).toEqual(['model-c', 'model-a', 'model-b']);
  });

  it('saves the edited list as an ordered array of ids', () => {
    renderEditor(['model-a', 'model-b']);
    fireEvent.click(screen.getByTestId('admin-recommended-models-model-b-up-btn'));
    fireEvent.click(screen.getByTestId('admin-recommended-models-model-a-remove-btn'));
    fireEvent.click(saveBtn());

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({ key: 'recommendedModelIds', value: ['model-b'] });
  });

  it('saves an emptied list as [] so the picker falls back to the default model', () => {
    renderEditor(['model-a']);
    fireEvent.click(screen.getByTestId('admin-recommended-models-model-a-remove-btn'));
    fireEvent.click(saveBtn());
    expect(mutate.mock.calls[0][0]).toEqual({ key: 'recommendedModelIds', value: [] });
  });

  it('treats a malformed stored value as an empty list', () => {
    renderEditor('not-a-list');
    expect(screen.queryAllByTestId(/^admin-recommended-models-row-/)).toHaveLength(0);
    expect(screen.getByTestId('admin-recommended-models-empty')).toBeTruthy();
  });
});
