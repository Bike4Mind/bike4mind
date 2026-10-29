import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), remove: vi.fn(), token: vi.fn(), confirm: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get, post: mocks.post, delete: mocks.remove } }));
vi.mock('@client/app/hooks/useAccessToken', () => ({ useAccessToken: () => true }));
vi.mock('@client/app/utils/turnstile', () => ({ getTurnstileToken: mocks.token }));
vi.mock('@client/app/hooks/data/credits', () => ({ CREDITS_BALANCE_KEY: ['credits-balance'] }));
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
