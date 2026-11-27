import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('@tanstack/react-router', () => ({
  useBlocker: () => ({ status: 'idle' }),
  useRouter: () => ({
    state: { location: { pathname: '/admin', search: { tab: 'admin-settings' } } },
    navigate: vi.fn(),
  }),
}));
const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api }));
const models = vi.hoisted(() => [
  { id: 'text-a', name: 'Text A', type: 'text', backend: 'openai' },
  { id: 'text-b', name: 'Text B', type: 'text', backend: 'openai' },
  { id: 'image-a', name: 'Image A', type: 'image', backend: 'openai' },
  { id: 'image-b', name: 'Image B', type: 'image', backend: 'openai' },
  { id: 'speech-a', name: 'Speech A', type: 'speech-to-text', backend: 'openai' },
  { id: 'speech-b', name: 'Speech B', type: 'speech-to-text', backend: 'openai' },
]);
vi.mock('@client/app/hooks/data/useModelInfo', () => ({ useModelInfo: () => ({ data: models }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AdminOperationsModelSetting } from './AdminOperationsModelSetting';
import { SettingsDraftProvider } from './SettingsDraftProvider';

const appTheme = extendTheme({ ...getThemeConfig() });
const config = { modelId: 'text-a', imageModelId: 'image-a', speechModelId: 'speech-a' };

const renderSetting = (withProvider = true) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const setting = <AdminOperationsModelSetting />;
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        {withProvider ? <SettingsDraftProvider>{setting}</SettingsDraftProvider> : setting}
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

const chooseModel = async (label: RegExp, name: string) => {
  fireEvent.click(await screen.findByRole('combobox', { name: label }));
  fireEvent.click(within(await screen.findByRole('listbox')).getByText(name));
};
const chooseTextModel = (name: string) => chooseModel(/primary operations model/i, name);

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ data: config });
  api.put.mockResolvedValue({
    data: {
      success: true,
      config,
      activeModel: {
        id: 'text-b',
        name: 'Text B',
        imageModelId: 'image-a',
        imageModelName: 'Image A',
        speechModelId: 'speech-a',
        speechModelName: 'Speech A',
      },
    },
  });
});

describe('AdminOperationsModelSetting', () => {
  it('stages a model change without writing, then saves the full config from the SaveBar', async () => {
    renderSetting();
    await chooseTextModel('Text B');
    expect(api.put).not.toHaveBeenCalled();
    expect(screen.queryByText('Save Operations Model')).toBeNull();
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put).toHaveBeenCalledWith('/api/admin/operations-model', { ...config, modelId: 'text-b' });
  });

  it('discards a staged change without writing', async () => {
    renderSetting();
    await chooseTextModel('Text B');
    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).toBeNull());
    expect(api.put).not.toHaveBeenCalled();
  });

  it.each([
    ['image', /image generation model/i, 'Image B', { imageModelId: 'image-b' }],
    ['speech', /speech-to-text model/i, 'Speech B', { speechModelId: 'speech-b' }],
  ])('stages and saves a %s model change', async (_kind, label, name, change) => {
    renderSetting();
    await chooseModel(label, name);
    expect(api.put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put).toHaveBeenCalledWith('/api/admin/operations-model', { ...config, ...change });
  });

  it('keeps the staged change and shows the error when the save fails', async () => {
    api.put.mockRejectedValue(new Error('Try again'));
    renderSetting();
    await chooseTextModel('Text B');
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    expect(await screen.findByText('Operations models was not saved: Try again.')).toBeTruthy();
    expect(screen.getByTestId('admin-save-bar').textContent).toContain('1 unsaved change');
  });

  it('blocks saving while a model id is missing', async () => {
    api.get.mockResolvedValue({ data: { modelId: 'text-a', imageModelId: 'image-a', speechModelId: '' } });
    renderSetting();
    await chooseTextModel('Text B');
    expect(
      await screen.findByText('Operations models: Choose text, image and speech models before saving.')
    ).toBeTruthy();
    const save = screen.getByTestId('admin-save-confirm-btn');
    expect(save).toHaveProperty('disabled', true);
    fireEvent.click(save);
    expect(api.put).not.toHaveBeenCalled();
  });

  it('throws when rendered outside a SettingsDraftProvider', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderSetting(false)).toThrow(
      'AdminOperationsModelSetting must be rendered inside a SettingsDraftProvider.'
    );
    error.mockRestore();
  });
});
