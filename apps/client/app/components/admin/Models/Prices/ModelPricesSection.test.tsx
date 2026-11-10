import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toastSuccess: vi.fn(),
  textModels: [
    { id: 'gpt-x', price: null },
    { id: 'gpt-new' },
    { id: 'local/anime v2:0', price: { source: 'build', pricing: {} } },
    { id: 'gpt-priced', price: { source: 'row', unit: 'per_token', pricing: {}, effectiveFrom: '2026-07-01' } },
  ],
  voiceModels: [{ id: 'voice-1' }],
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess } }));
vi.mock('@tanstack/react-router', async () => (await import('../../__tests__/fakeAdminRouter')).fakeRouterModule);
vi.mock('@client/app/hooks/data/adminModels', () => ({
  ADMIN_MODELS_QUERY_KEY: ['admin', 'models'],
  useAdminModelsOfType: (type: string) => ({
    data: type === 'text' ? mocks.textModels : type === 'realtime-voice' ? mocks.voiceModels : [],
    isLoading: false,
    isError: false,
  }),
}));
vi.mock('../ModelWriteAction', () => ({
  ModelWriteAction: ({ children }: { children: (disabled: boolean) => React.ReactElement }) => children(false),
}));
vi.mock('../Discovery/useModelIndex', () => ({ useModelIndex: () => ({ data: undefined }) }));

import { fakeAdminRouter } from '../../__tests__/fakeAdminRouter';
import { ModelPricesSection } from './ModelPricesSection';

const ROWS = [
  {
    modelId: 'gpt-x',
    unit: 'per_token',
    pricing: { '0': { input: 4e-6, output: 16e-6 } },
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    note: 'adapter-seed',
  },
  {
    modelId: 'gpt-y',
    unit: 'per_token',
    pricing: { '0': { input: 9e-6, output: 27e-6 } },
    effectiveFrom: '2026-07-05T00:00:00.000Z',
  },
];

const appTheme = extendTheme({ ...getThemeConfig() });
let queryClient: QueryClient;
const renderSection = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <ModelPricesSection />
      </CssVarsProvider>
    </QueryClientProvider>
  );

const fillDialog = async (modelId: string) => {
  fireEvent.click(screen.getByTestId('model-prices-add-btn'));
  const dialog = await screen.findByTestId('add-price-dialog');
  const input = within(dialog).getByTestId('add-price-model-input');
  await userEvent.click(input);
  await userEvent.type(input, modelId);
  await userEvent.click(await screen.findByRole('option', { name: modelId }));
  fireEvent.change(within(dialog).getByTestId('add-price-rate-0-input'), { target: { value: '2.5' } });
  fireEvent.change(within(dialog).getByTestId('add-price-rate-0-output'), { target: { value: '10' } });
  fireEvent.change(within(dialog).getByTestId('add-price-dialog-reason-input'), {
    target: { value: 'Provider price list' },
  });
  return dialog;
};

describe('ModelPricesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient();
    act(() => fakeAdminRouter.reset({ tab: 'models', modelsSection: 'prices' }));
    mocks.get.mockResolvedValue({ data: { rows: ROWS } });
    mocks.post.mockResolvedValue({ data: {} });
  });

  it('states the units and shows every row without a model param', async () => {
    renderSection();
    expect(screen.getByTestId('model-prices-units')).toHaveTextContent('Provider cost in USD; token rates per 1M');
    expect(await screen.findByTestId('model-pricing-row-gpt-x-per_token')).toBeInTheDocument();
    expect(screen.getByTestId('model-pricing-row-gpt-y-per_token')).toBeInTheDocument();
  });

  it('shows only the model a deep link names', async () => {
    act(() => fakeAdminRouter.reset({ tab: 'models', modelsSection: 'prices', model: 'gpt-y' }));
    renderSection();
    expect(await screen.findByTestId('model-pricing-row-gpt-y-per_token')).toBeInTheDocument();
    expect(screen.queryByTestId('model-pricing-row-gpt-x-per_token')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-pricing-filter-input')).toHaveValue('gpt-y');
  });

  it('filters as typed and writes the filter to the URL once typing pauses, clearing the param when emptied', async () => {
    renderSection();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    const input = screen.getByTestId('model-pricing-filter-input');
    await userEvent.type(input, 'gpt-x');
    expect(input).toHaveValue('gpt-x');
    expect(screen.queryByTestId('model-pricing-row-gpt-y-per_token')).not.toBeInTheDocument();

    await waitFor(() =>
      expect(fakeAdminRouter.search).toMatchObject({ tab: 'models', modelsSection: 'prices', model: 'gpt-x' })
    );
    expect(fakeAdminRouter.navigate).toHaveBeenCalledTimes(1);
    expect(fakeAdminRouter.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ replace: true }));

    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => expect(fakeAdminRouter.search).not.toHaveProperty('model'));
    expect(input).toHaveValue('');
  });

  it('follows a model param changed from outside the box', async () => {
    renderSection();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    act(() => {
      fakeAdminRouter.navigate({ to: '/admin', search: previous => ({ ...previous, model: 'gpt-y' }) });
    });
    expect(screen.getByTestId('model-pricing-filter-input')).toHaveValue('gpt-y');
    expect(screen.queryByTestId('model-pricing-row-gpt-x-per_token')).not.toBeInTheDocument();
  });

  it('posts a first per-token price for a text model, then refreshes and toasts', async () => {
    renderSection();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await fillDialog('gpt-new');

    fireEvent.click(screen.getByTestId('add-price-dialog-confirm-btn'));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/model-prices', {
      modelId: 'gpt-new',
      unit: 'per_token',
      pricing: { '0': { input: 2.5e-6, output: 10e-6 } },
      note: 'Provider price list',
    });
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith('Price added. Open pickers update within about 15 seconds.')
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'models'] });
    await waitFor(() => expect(screen.queryByTestId('add-price-dialog')).not.toBeInTheDocument());
  });

  it('offers only text and realtime-voice models with no price row in force', async () => {
    renderSection();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    fireEvent.click(screen.getByTestId('model-prices-add-btn'));
    const dialog = await screen.findByTestId('add-price-dialog');
    await userEvent.click(within(dialog).getByTestId('add-price-model-input'));
    const options = await screen.findAllByRole('option');
    expect(options.map(option => option.textContent)).toEqual(['gpt-x', 'gpt-new', 'local/anime v2:0', 'voice-1']);
  });

  it('does not preselect a filtered model that already has a price row', async () => {
    act(() => fakeAdminRouter.reset({ tab: 'models', modelsSection: 'prices', model: 'gpt-priced' }));
    renderSection();
    fireEvent.click(await screen.findByTestId('model-prices-add-btn'));
    const dialog = await screen.findByTestId('add-price-dialog');
    expect(within(dialog).getByTestId('add-price-model-input')).toHaveValue('');
  });

  it('preselects the filtered model when it is a text model', async () => {
    act(() => fakeAdminRouter.reset({ tab: 'models', modelsSection: 'prices', model: 'gpt-new' }));
    renderSection();
    fireEvent.click(await screen.findByTestId('model-prices-add-btn'));
    const dialog = await screen.findByTestId('add-price-dialog');
    expect(within(dialog).getByTestId('add-price-model-input')).toHaveValue('gpt-new');
  });

  it('shows the 422 message inline and keeps the dialog open', async () => {
    mocks.post.mockRejectedValue({
      response: { data: { error: "Prices for non-text models come from this build's model tables" } },
    });
    renderSection();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    await fillDialog('gpt-x');
    fireEvent.click(screen.getByTestId('add-price-dialog-confirm-btn'));

    expect(await screen.findByTestId('add-price-error')).toHaveTextContent(
      "Prices for non-text models come from this build's model tables"
    );
    expect(screen.getByTestId('add-price-dialog')).toBeInTheDocument();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('asks for the confirm token above the ceiling and resubmits it', async () => {
    mocks.post.mockRejectedValueOnce({
      response: { data: { error: 'rate above the ceiling', code: 'manual-reprice-over-band', confirmToken: 'tok-1' } },
    });
    renderSection();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    await fillDialog('gpt-new');
    fireEvent.click(screen.getByTestId('add-price-dialog-confirm-btn'));

    expect(await screen.findByTestId('add-price-error')).toHaveTextContent('rate above the ceiling');
    const confirm = screen.getByTestId('add-price-dialog-confirm-btn');
    expect(confirm).toHaveTextContent('Apply anyway');
    fireEvent.click(confirm);

    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post.mock.calls[1][1]).toMatchObject({ modelId: 'gpt-new', confirm: 'tok-1' });
  });

  it('shows the markup preview and holds the commit until the draft is complete', async () => {
    renderSection();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    fireEvent.click(screen.getByTestId('model-prices-add-btn'));
    const dialog = await screen.findByTestId('add-price-dialog');
    expect(within(dialog).getByTestId('add-price-dialog-confirm-btn')).toBeDisabled();
    fireEvent.change(within(dialog).getByTestId('add-price-rate-0-input'), { target: { value: '2' } });
    expect(within(dialog).getByTestId('add-price-markup-0')).toHaveTextContent('a user pays about');
  });
});
