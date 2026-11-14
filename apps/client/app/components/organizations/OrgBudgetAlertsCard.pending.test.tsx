import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IOrgBudgetAlerts } from '@bike4mind/common';
import OrgBudgetAlertsCard from './OrgBudgetAlertsCard';

const requests = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: requests }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const theme = extendTheme({ ...getThemeConfig() });
const initial: IOrgBudgetAlerts = {
  enabled: true,
  monthlyBudgetCredits: 100,
  percentThresholds: [80],
  lowBalanceCredits: 0,
};
const setup = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={theme}>
        <OrgBudgetAlertsCard organizationId="org" />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};
const input = (name: string) => screen.getByTestId(`org-alerts-${name}`);

beforeEach(() => {
  vi.clearAllMocks();
  requests.get.mockResolvedValue({ data: { budgetAlerts: initial } });
});
describe('budget alert draft with real query mutations', () => {
  it.each(['success', 'failure'])('locks every editor during a pending %s and permits retry', async outcome => {
    let resolveRequest: (response: { data: { budgetAlerts: IOrgBudgetAlerts } }) => void = () => {
      throw new Error('Request not started');
    };
    let rejectRequest: (error: Error) => void = () => {
      throw new Error('Request not started');
    };
    requests.put.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          resolveRequest = resolve;
          rejectRequest = reject;
        })
    );
    setup();
    await waitFor(() => expect(input('budget-input')).toHaveValue('100'));
    fireEvent.change(input('budget-input'), { target: { value: '200' } });
    fireEvent.click(input('save-btn'));
    fireEvent.click(input('save-btn'));
    await waitFor(() => expect(requests.put).toHaveBeenCalledTimes(1));
    for (const name of [
      'enable-switch',
      'budget-input',
      'threshold-input',
      'threshold-add-btn',
      'threshold-80-remove-btn',
      'low-balance-input',
      'save-btn',
    ])
      expect(input(name)).toBeDisabled();
    fireEvent.change(input('budget-input'), { target: { value: '999' } });
    fireEvent.change(input('low-balance-input'), { target: { value: '999' } });
    expect(input('budget-input')).toHaveValue('200');
    expect(input('low-balance-input')).toHaveValue('0');
    await act(async () => {
      if (outcome === 'success') resolveRequest({ data: { budgetAlerts: { ...initial, monthlyBudgetCredits: 200 } } });
      else rejectRequest(new Error('Save failed'));
    });
    await waitFor(() => expect(input('save-btn')).not.toBeDisabled());
    expect(input('budget-input')).toHaveValue('200');
    requests.put.mockResolvedValueOnce({ data: { budgetAlerts: { ...initial, monthlyBudgetCredits: 300 } } });
    fireEvent.change(input('budget-input'), { target: { value: '300' } });
    fireEvent.click(input('save-btn'));
    await waitFor(() => expect(requests.put).toHaveBeenCalledTimes(2));
  });
});
