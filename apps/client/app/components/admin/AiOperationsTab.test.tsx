import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminAiConfigSchema, ADMIN_AI_FEATURES } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import AiOperationsTab from './AiOperationsTab';

const request = vi.hoisted(() => vi.fn());
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { request } }));
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
afterEach(() => request.mockReset());
describe('AI operations page', () => {
  it('shows manual fallback, exact ladder and stages an audited settings write', async () => {
    request.mockResolvedValue({ data });
    mount();
    expect(await screen.findByTestId('ai-operations-budget-alert')).toHaveTextContent(
      'manual controls remain available'
    );
    expect(screen.getByText(/offline replay agreement at least 90%/)).toHaveTextContent(
      'at least 100 decided suggestions over 14 days'
    );
    fireEvent.click(screen.getByTestId('ai-operations-global-switch'));
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1][0]).toEqual({
      method: 'PUT',
      url: '/api/admin/ai-operations',
      data: { ...config, enabled: true },
    });
  });
  it('renders permission failures as a retryable error without controls', async () => {
    request.mockRejectedValue(
      new AxiosError('Forbidden', '403', undefined, undefined, {
        status: 403,
        statusText: 'Forbidden',
        headers: {},
        config: { headers: new AxiosHeaders() },
        data: { message: 'Missing settings:manage' },
      })
    );
    mount();
    expect(await screen.findByTestId('admin-error-state')).toHaveTextContent('Missing settings:manage');
    expect(screen.queryByTestId('ai-operations-global-switch')).not.toBeInTheDocument();
  });
});
