import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';

type Mapping = {
  id: string;
  mainModelId: string;
  rapidModelId: string;
  enabled: boolean;
  priority: number;
  maxTokens: number;
  responseStyle: string;
  maxLatency: number;
  systemPrompt: string;
};

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  updateSettings: vi.fn(),
  deleteMapping: vi.fn(),
  useBlocker: vi.fn(() => ({ status: 'idle' })),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.apiGet } }));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({
    isLoading: false,
    settings: {
      RapidReplySettings: {
        transitionMode: 'replace',
        fallbackBehavior: 'continue',
        maxAcceptableLatency: 2000,
        minSuccessRate: 90,
      },
    },
  }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useExperimentalFeatureSettings: () => ({
    isLoading: false,
    data: [{ settingName: 'EnableRapidReply', settingValue: 'false' }],
  }),
  useUpdateSettings: () => ({ mutateAsync: mocks.updateSettings, isPending: false }),
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: [{ id: 'main-model', name: 'Main model' }] }),
}));
vi.mock('@client/app/hooks/data/rapidReplyMutations', () => ({
  useSaveMapping: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useDeleteMapping: () => ({ mutate: mocks.deleteMapping, isPending: false, error: null }),
  useTestConfiguration: () => ({ mutateAsync: vi.fn(), isPending: false, error: null, data: undefined }),
}));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('@tanstack/react-router', async () => ({
  ...(await import('./__tests__/fakeAdminRouter')).fakeRouterModule,
  useBlocker: mocks.useBlocker,
}));

import { fakeAdminRouter } from './__tests__/fakeAdminRouter';
import RapidReplyTab from './RapidReplyTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const mapping = (overrides: Partial<Mapping> = {}): Mapping => ({
  id: 'mapping-1',
  mainModelId: 'main-model',
  rapidModelId: 'fast-model',
  enabled: true,
  priority: 1,
  maxTokens: 100,
  responseStyle: 'auto',
  maxLatency: 1500,
  systemPrompt: 'Acknowledge briefly.',
  ...overrides,
});

let mappingsResponse: { mappings: Mapping[]; unavailableRapidModelIds?: string[] } | Error;

const renderTab = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <RapidReplyTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );

beforeEach(() => {
  mappingsResponse = { mappings: [mapping()] };
  mocks.apiGet.mockReset().mockImplementation(async (url: string) => {
    if (url.endsWith('/mappings')) {
      if (mappingsResponse instanceof Error) throw mappingsResponse;
      return { data: mappingsResponse };
    }
    return { data: null };
  });
  mocks.updateSettings.mockReset().mockResolvedValue({});
  mocks.deleteMapping.mockReset();
  fakeAdminRouter.reset({ tab: 'rapid-reply' });
});

describe('RapidReplyTab', () => {
  it('opens with the page header and adds no padding of its own', () => {
    renderTab();

    const tab = screen.getByTestId('admin-rapid-reply-tab');
    const header = tab.firstElementChild as HTMLElement;
    expect(header).toHaveAttribute('data-testid', 'admin-page-header');
    expect(within(header).getByRole('heading', { level: 1 }).textContent).toBe('Rapid reply');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(tab).toHaveStyle({ maxWidth: '1280px' });
    expect(tab).not.toHaveStyle({ padding: '16px' });
    expect(tab.querySelector('.MuiCard-root')).toBeNull();
  });

  it('labels the views with plain text tabs', () => {
    renderTab();

    for (const name of ['Models', 'Metrics', 'Test']) {
      const tab = screen.getByRole('tab', { name });
      expect(tab.querySelector('svg')).toBeNull();
    }
  });

  it('lists mappings in a table and flags an unavailable rapid model', async () => {
    mappingsResponse = { mappings: [mapping()], unavailableRapidModelIds: ['fast-model'] };
    renderTab();

    const table = await screen.findByTestId('rapid-reply-mappings-table');
    expect(await within(table).findByText('main-model')).toBeTruthy();
    expect(screen.getByTestId('rapid-reply-mapping-unavailable-chip').textContent).toBe('Model unavailable');
    expect(screen.getByRole('heading', { level: 2, name: /Model mappings \(1\)/ })).toBeTruthy();
  });

  it('shows the empty state with the next step when there are no mappings', async () => {
    mappingsResponse = { mappings: [] };
    renderTab();

    const empty = await screen.findByTestId('admin-empty-state');
    expect(empty.textContent).toContain('No model mappings yet');
    expect(within(empty).getByTestId('rapid-reply-create-first-mapping-btn')).toBeTruthy();
    expect(screen.queryByTestId('rapid-reply-new-mapping-btn')).toBeNull();
  });

  it('shows an error with a retry when mappings fail to load', async () => {
    mappingsResponse = new Error('boom');
    renderTab();

    expect((await screen.findByTestId('admin-error-state')).textContent).toContain(
      'Model mappings could not be loaded.'
    );
    mappingsResponse = { mappings: [mapping()] };
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('rapid-reply-mappings-table')).toBeTruthy();
  });

  it('stages every setting into one SaveBar and saves only what changed', async () => {
    renderTab();

    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
    expect(screen.queryByRole('button', { name: /save settings|save thresholds/i })).toBeNull();

    fireEvent.click(within(screen.getByTestId('rapid-reply-enabled-switch')).getByRole('switch'));
    expect(screen.getByTestId('admin-save-bar').textContent).toContain('1 unsaved change');

    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    fireEvent.change(screen.getByTestId('rapid-reply-max-latency-input').querySelector('input')!, {
      target: { value: '1500' },
    });
    expect(screen.getAllByTestId('admin-save-bar')).toHaveLength(1);
    expect(screen.getByTestId('admin-save-bar').textContent).toContain('2 unsaved changes');

    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).toBeNull());

    expect(mocks.updateSettings).toHaveBeenCalledWith({ key: 'EnableRapidReply', value: true });
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({
      key: 'RapidReplySettings',
      value: {
        transitionMode: 'replace',
        fallbackBehavior: 'continue',
        maxAcceptableLatency: 1500,
        minSuccessRate: 90,
      },
    });
  });

  it('keeps every staged RapidReplySettings field when the SaveBar writes them one after another', async () => {
    renderTab();

    fireEvent.click(within(screen.getByTestId('rapid-reply-transition-mode-select')).getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'append' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    fireEvent.change(screen.getByTestId('rapid-reply-max-latency-input').querySelector('input')!, {
      target: { value: '1500' },
    });
    fireEvent.change(screen.getByTestId('rapid-reply-min-success-rate-input').querySelector('input')!, {
      target: { value: '80' },
    });
    expect(screen.getByTestId('admin-save-bar').textContent).toContain('3 unsaved changes');

    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).toBeNull());

    // Each field is its own draft and its own write; each write builds on the one before it, so the
    // last write carries all three edits rather than only its own field over the stale baseline.
    const writes = mocks.updateSettings.mock.calls.map(([call]) => call);
    expect(writes).toHaveLength(3);
    expect(writes.every(write => write.key === 'RapidReplySettings')).toBe(true);
    expect(writes.at(-1)).toEqual({
      key: 'RapidReplySettings',
      value: {
        transitionMode: 'append',
        fallbackBehavior: 'continue',
        maxAcceptableLatency: 1500,
        minSuccessRate: 80,
      },
    });
  });

  it('blocks the save while a threshold is out of range', () => {
    renderTab();

    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    fireEvent.change(screen.getByTestId('rapid-reply-min-success-rate-input').querySelector('input')!, {
      target: { value: '150' },
    });

    const bar = screen.getByTestId('admin-save-bar');
    expect(bar.textContent).toContain('Min success rate: Enter 0 to 100%');
    expect(within(bar).getByTestId('admin-save-confirm-btn')).toBeDisabled();
  });

  it('confirms a delete in a dialog instead of the browser prompt', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderTab();

    fireEvent.click(await screen.findByTestId('rapid-reply-delete-mapping-mapping-1'));
    const dialog = screen.getByTestId('rapid-reply-delete-dialog');
    expect(dialog.textContent).toContain('This cannot be undone.');

    fireEvent.click(within(dialog).getByTestId('rapid-reply-delete-confirm-btn'));
    expect(mocks.deleteMapping).toHaveBeenCalledWith('mapping-1', expect.anything());
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('shows the metrics empty state with a way back to the mappings', async () => {
    renderTab();

    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    const empty = await screen.findByTestId('admin-empty-state');
    expect(empty.textContent).toContain('No rapid replies yet');

    fireEvent.click(within(empty).getByTestId('rapid-reply-metrics-open-models-btn'));
    expect(screen.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true');
  });
});
