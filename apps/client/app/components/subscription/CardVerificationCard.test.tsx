import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => {
  class CancelledError extends Error {}
  return { get: vi.fn(), post: vi.fn(), remove: vi.fn(), token: vi.fn(), confirm: vi.fn(), CancelledError };
});
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get, post: mocks.post, delete: mocks.remove } }));
vi.mock('@client/app/hooks/useAccessToken', () => ({ useAccessToken: () => true }));
vi.mock('@client/app/utils/turnstile', () => ({
  getTurnstileToken: mocks.token,
  TurnstileCancelledError: mocks.CancelledError,
}));
vi.mock('@client/app/hooks/data/credits', () => ({
  CREDITS_BALANCE_KEY: ['credits-balance'],
  CREDIT_TRANSACTIONS_KEY: ['credit-transactions'],
}));
vi.mock('@stripe/stripe-js', () => ({ loadStripe: async () => ({}) }));
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: React.ReactNode }) => children,
  PaymentElement: () => <div data-testid="stripe-hosted-element" />,
  useStripe: () => ({ confirmSetup: mocks.confirm }),
  useElements: () => ({}),
}));
import { CardVerificationCard } from './CardVerificationCard';
const offer = {
  available: true,
  credits: 17,
  siteKey: 'synthetic-site',
  saved: [] as string[],
  pending: [] as string[],
};
const theme = extendTheme({ ...getThemeConfig() });
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={theme}>
        <CardVerificationCard entry="exhaustion" />
      </CssVarsProvider>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ data: offer });
  mocks.token.mockResolvedValue('synthetic-token');
  mocks.confirm.mockResolvedValue({ setupIntent: { status: 'succeeded' } });
});
describe('card verification offer', () => {
  it('hides unavailable offers', async () => {
    mocks.get.mockResolvedValue({ data: { ...offer, available: false } });
    mount();
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    expect(screen.queryByTestId('card-verification-card')).toBeNull();
  });
  it('starts only after challenge with explicit default no-save and no-charge copy', async () => {
    mocks.post.mockResolvedValueOnce({
      data: { verificationId: 'synthetic-id', clientSecret: 'synthetic-secret', publishableKey: 'synthetic-public' },
    });
    mount();
    fireEvent.click(await screen.findByTestId('card-verification-start-btn'));
    await screen.findByTestId('stripe-hosted-element');
    expect(mocks.token).toHaveBeenCalledWith('synthetic-site', 'card_verification');
    expect(mocks.post).toHaveBeenCalledWith('/api/stripe/card-verification', {
      turnstileToken: 'synthetic-token',
      saveCard: false,
      entry: 'exhaustion',
    });
    expect(screen.getByTestId('card-verification-confirm-btn')).toHaveTextContent('no charge');
    mocks.post.mockResolvedValueOnce({ data: { outcome: 'granted' } });
    fireEvent.click(screen.getByTestId('card-verification-confirm-btn'));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('card-verification-result')).toHaveTextContent('not charged'));
  });
  it('reopens the hosted form for an unconfirmed verification', async () => {
    mocks.get.mockResolvedValue({ data: { ...offer, available: false, pending: ['synthetic-id'] } });
    mocks.post.mockResolvedValueOnce({
      data: { outcome: 'pending', clientSecret: 'synthetic-secret', publishableKey: 'synthetic-public' },
    });
    mount();
    fireEvent.click(await screen.findByTestId('card-verification-retry-btn'));
    await screen.findByTestId('stripe-hosted-element');
    expect(mocks.post).toHaveBeenCalledWith('/api/stripe/card-verification', { verificationId: 'synthetic-id' });
    expect(mocks.token).not.toHaveBeenCalled();
  });
  it('reports credits arriving when the verification cannot be reopened', async () => {
    mocks.get.mockResolvedValue({ data: { ...offer, available: false, pending: ['synthetic-id'] } });
    mocks.post.mockResolvedValueOnce({ data: { outcome: 'pending' } });
    mount();
    fireEvent.click(await screen.findByTestId('card-verification-retry-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('card-verification-result')).toHaveTextContent(
        'Your credits will appear once it finishes'
      )
    );
    expect(screen.queryByTestId('stripe-hosted-element')).toBeNull();
  });
  it('shows the server refusal text', async () => {
    mocks.post.mockRejectedValueOnce(
      new AxiosError('refused', '403', undefined, undefined, {
        status: 403,
        data: { error: 'This card is not supported. Use another card.' },
      } as AxiosError['response'])
    );
    mount();
    fireEvent.click(await screen.findByTestId('card-verification-start-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('card-verification-result')).toHaveTextContent('This card is not supported')
    );
  });
  it('falls back to the generic message without a server error body', async () => {
    mocks.post.mockRejectedValueOnce(new Error('network'));
    mount();
    fireEvent.click(await screen.findByTestId('card-verification-start-btn'));
    await waitFor(() => expect(screen.getByTestId('card-verification-result')).toHaveTextContent('could not finish'));
  });
  it('treats a cancelled challenge as a silent cancel', async () => {
    mocks.token.mockRejectedValueOnce(new mocks.CancelledError());
    mount();
    fireEvent.click(await screen.findByTestId('card-verification-start-btn'));
    await waitFor(() => expect(mocks.token).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('card-verification-start-btn')).not.toBeDisabled());
    expect(screen.queryByTestId('card-verification-result')).toBeNull();
  });
  it('closes the modal when the confirm finds the verification already finishing', async () => {
    mocks.post.mockResolvedValueOnce({
      data: { verificationId: 'synthetic-id', clientSecret: 'synthetic-secret', publishableKey: 'synthetic-public' },
    });
    mount();
    fireEvent.click(await screen.findByTestId('card-verification-start-btn'));
    await screen.findByTestId('stripe-hosted-element');
    mocks.post.mockResolvedValueOnce({ data: { outcome: 'pending' } });
    fireEvent.click(screen.getByTestId('card-verification-confirm-btn'));
    await waitFor(() => expect(screen.queryByTestId('stripe-hosted-element')).toBeNull());
    expect(screen.getByTestId('card-verification-result')).toHaveTextContent(
      'Your credits will appear once it finishes'
    );
  });
  it('confirms once when the form is submitted twice in one tick', async () => {
    mocks.post.mockResolvedValueOnce({
      data: { verificationId: 'synthetic-id', clientSecret: 'synthetic-secret', publishableKey: 'synthetic-public' },
    });
    mount();
    fireEvent.click(await screen.findByTestId('card-verification-start-btn'));
    await screen.findByTestId('stripe-hosted-element');
    mocks.post.mockResolvedValueOnce({ data: { outcome: 'granted' } });
    const form = screen.getByTestId('card-verification-confirm-btn').closest('form');
    if (!form) throw new Error('form missing');
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByTestId('card-verification-result')).toHaveTextContent('not charged'));
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
  });
  it('removes only the server-provided saved verification', async () => {
    mocks.get.mockResolvedValue({ data: { ...offer, available: false, saved: ['synthetic-id'] } });
    mocks.remove.mockResolvedValue({ data: { removed: true } });
    mount();
    fireEvent.click(await screen.findByTestId('card-verification-remove-btn'));
    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledWith('/api/stripe/card-verification', {
        data: { verificationId: 'synthetic-id' },
      })
    );
  });
});
