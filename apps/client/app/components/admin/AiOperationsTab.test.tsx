import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAiConfigSchema, ADMIN_AI_FEATURES } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { api } from '@client/app/contexts/ApiContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import type { InternalAxiosRequestConfig } from 'axios';
import AiOperationsTab from './AiOperationsTab';

vi.mock('./shared/UnsavedChangesGuard', () => ({ UnsavedChangesGuard: () => null }));
const config = AdminAiConfigSchema.parse({});
const data = {
  config,
  monthUsd: 0,
  budgetState: 'stopped',
  classes: [],
  recent: [],
  coverage: 'Historical failures unavailable; unknown costs excluded.',
  features: ADMIN_AI_FEATURES.map(feature => ({
    feature,
    mode: 'off',
    todayUsd: 0,
    monthUsd: 0,
    callsToday: 0,
    unknownCostAttempts: 0,
    skips: [],
    accepted7: 0,
    overridden7: 0,
    accepted30: 0,
    overridden30: 0,
  })),
};
const theme = extendTheme({ ...getThemeConfig() });
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  return render(<AiOperationsTab />, { wrapper: Wrapper });
}
const originalAdapter = api.defaults.adapter;
const response = (request: InternalAxiosRequestConfig, value = data) => ({
  data: value,
  status: 200,
  statusText: 'OK',
  headers: {},
  config: request,
});
beforeEach(() => useAccessToken.getState().setAccessToken('test-admin-token'));
afterEach(() => {
  api.defaults.adapter = originalAdapter;
  useAccessToken.getState().resetTokens();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}
function expectEditorsDisabled(disabled: boolean) {
  for (const editor of document.querySelectorAll(
    'input[data-testid^="ai-operations-"], [data-testid^="ai-operations-"] input:not([type="hidden"]):not([aria-hidden="true"]), [data-testid^="ai-operations-"][role="combobox"]'
  )) {
    if (disabled) expect(editor).toBeDisabled();
    else expect(editor).not.toBeDisabled();
  }
}
function stageClass() {
  fireEvent.change(screen.getByTestId('ai-operations-class-name').querySelector('input')!, {
    target: { value: 'triage' },
  });
  fireEvent.change(screen.getByTestId('ai-operations-class-policy').querySelector('input')!, {
    target: { value: 'v1' },
  });
}
describe('AI operations page', () => {
  it('loads and saves through the authenticated transport', async () => {
    const adapter = vi.fn(async (request: InternalAxiosRequestConfig) => response(request));
    api.defaults.adapter = adapter;
    mount();
    expect(await screen.findByTestId('ai-operations-budget-alert')).toHaveTextContent(
      'manual controls remain available'
    );
    expect(screen.getByText(/offline replay agreement at least 90%/)).toHaveTextContent(
      'at least 100 decided suggestions over 14 days'
    );
    fireEvent.click(screen.getByTestId('ai-operations-global-switch'));
    expect(adapter).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() => expect(adapter).toHaveBeenCalledTimes(2));
    const requests = adapter.mock.calls.map(([request]) => request);
    expect(requests.map(request => request.method)).toEqual(['get', 'put']);
    for (const request of requests) {
      expect(request.url).toBe('/api/admin/ai-operations');
      expect(request.headers.Authorization).toBe('Bearer test-admin-token');
    }
    expect(JSON.parse(requests[1].data as string)).toEqual({ ...config, enabled: true });
  });
  it('renders permission failures as a retryable error without controls', async () => {
    api.defaults.adapter = async () => {
      throw new Error('Request failed (403)');
    };
    mount();
    expect(await screen.findByTestId('admin-error-state')).toHaveTextContent('403');
    expect(screen.queryByTestId('ai-operations-global-switch')).not.toBeInTheDocument();
  });
  it.each(['put', 'post'])('locks every draft editor during a delayed %s and retains failed drafts', async method => {
    const gate = deferred();
    api.defaults.adapter = async request => {
      if (request.method === method) {
        await gate.promise;
        throw new Error('Save failed');
      }
      return response(request);
    };
    mount();
    await screen.findByTestId('ai-operations-global-switch');
    if (method === 'put') fireEvent.click(screen.getByTestId('ai-operations-global-switch'));
    else stageClass();
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() => expectEditorsDisabled(true));
    gate.resolve();
    expect(await screen.findByText('Save failed')).toBeInTheDocument();
    expectEditorsDisabled(false);
    if (method === 'put') expect(screen.getByTestId('ai-operations-global-switch')).toBeChecked();
    else expect(screen.getByTestId('ai-operations-class-name').querySelector('input')).toHaveValue('triage');
    expect(screen.getByTestId('admin-save-bar')).toBeInTheDocument();
  });
  it('keeps a failed config draft after committing class evidence and does not submit the class twice', async () => {
    let failConfig = true;
    const adapter = vi.fn(async (request: InternalAxiosRequestConfig) => {
      if (request.method === 'put' && failConfig) throw new Error('Config failed');
      return response(request);
    });
    api.defaults.adapter = adapter;
    mount();
    await screen.findByTestId('ai-operations-global-switch');
    stageClass();
    fireEvent.click(screen.getByTestId('ai-operations-global-switch'));
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    expect(await screen.findByText('Config failed')).toBeInTheDocument();
    expect(screen.getByTestId('ai-operations-global-switch')).toBeChecked();
    expect(screen.getByTestId('ai-operations-class-name').querySelector('input')).toHaveValue('');
    failConfig = false;
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).not.toBeInTheDocument());
    expect(adapter.mock.calls.map(([request]) => request.method)).toEqual(['get', 'post', 'put', 'put']);
  });
});
