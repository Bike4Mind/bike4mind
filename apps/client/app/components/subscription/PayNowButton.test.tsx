import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, AxiosHeaders } from 'axios';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import PayNowButton from './PayNowButton';

const post = vi.hoisted(() => vi.fn());
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post } }));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });

const httpError = (status: number, error: string) =>
  new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
    status,
    statusText: '',
    data: { error },
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

const renderButton = () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  render(wrapper(<PayNowButton subscriptionId="sub_1" testId="plan-card-pay-now-btn" />));
  return { invalidate };
};

const clickPay = () => userEvent.setup({ delay: null }).click(screen.getByTestId('plan-card-pay-now-btn'));

describe('PayNowButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('confirms a paid invoice, refreshes the plan and stays disabled while the webhook catches up', async () => {
    post.mockResolvedValue({ data: { status: 'paid' } });
    const { invalidate } = renderButton();

    await clickPay();

    expect(post).toHaveBeenCalledWith('/api/subscriptions/pay-invoice', { subscriptionId: 'sub_1' });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('profile.pay_now_success'));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['subscriptions'] });
    expect(screen.getByTestId('plan-card-pay-now-btn')).toBeDisabled();
    expect(screen.getByTestId('plan-card-pay-now-btn')).toHaveTextContent('profile.pay_now_received');
  });

  it('sends the user to the hosted invoice when the bank asks for authentication', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    post.mockResolvedValue({ data: { status: 'requires_action', hostedInvoiceUrl: 'https://invoice.stripe.com/i/x' } });
    renderButton();

    await clickPay();

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://invoice.stripe.com/i/x'));
    expect(toast.success).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('shows a card decline inline instead of in a toast', async () => {
    post.mockRejectedValue(httpError(402, 'Your card has insufficient funds.'));
    renderButton();

    await clickPay();

    expect(await screen.findByTestId('plan-card-pay-now-btn-error')).toHaveTextContent(
      'Your card has insufficient funds.'
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByTestId('plan-card-pay-now-btn')).toBeEnabled();
  });

  it('toasts any other failure', async () => {
    post.mockRejectedValue(httpError(409, 'There is no open invoice to pay.'));
    renderButton();

    await clickPay();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('There is no open invoice to pay.'));
    expect(screen.queryByTestId('plan-card-pay-now-btn-error')).toBeNull();
  });
});
