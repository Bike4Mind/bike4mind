import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';
import type { PaymentFulfillmentPage } from '@client/app/utils/paymentFulfillment';

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));
vi.mock('../shared/useAdminListUrlState', () => ({
  useAdminListUrlState: () => [
    { view: 'open', filters: { days: '7', state: '', ownerType: '', cursor: '' } },
    mocks.update,
  ],
}));
import { PaymentFulfillmentReview } from './PaymentFulfillmentReview';

const theme = extendTheme({ ...getThemeConfig() });
const page: PaymentFulfillmentPage = {
  availability: 'available',
  checkedAt: '2026-11-10T00:00:00Z',
  from: '2026-11-03T00:00:00Z',
  scanned: 1,
  nextCursor: 'pi_next',
  items: [],
};
const renderReview = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={theme}>
        <PaymentFulfillmentReview />
      </CssVarsProvider>
    </QueryClientProvider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ data: page });
});

describe('payment fulfillment review', () => {
  it('shows coverage, an honest empty state and pagination on a filtered empty page', async () => {
    renderReview();
    expect(await screen.findByText('No matching records on this page')).toBeTruthy();
    expect(screen.getByTestId('payment-review-coverage')).toHaveTextContent('Scanned 1');
    fireEvent.click(screen.getByTestId('payment-review-next-btn'));
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ filters: expect.objectContaining({ cursor: 'pi_next' }) })
    );
  });
  it('does not present unavailable evidence as an empty successful review', async () => {
    mocks.get.mockResolvedValue({ data: { ...page, availability: 'unavailable' } });
    renderReview();
    expect(await screen.findByTestId('payment-review-unavailable')).toHaveTextContent('No consistency conclusion');
    expect(screen.queryByText('No matching records on this page')).toBeNull();
  });
  it('shows request errors separately', async () => {
    mocks.get.mockRejectedValue(new Error('request failed'));
    renderReview();
    expect(await screen.findByText('Payment review could not be loaded.')).toBeTruthy();
  });
  it('renders inspectable provider and ledger evidence with owner links', async () => {
    mocks.get.mockResolvedValue({
      data: {
        ...page,
        items: [
          {
            id: 'pi_1',
            state: 'unknown',
            explanation: 'Historical entitlement unknown',
            createdAt: page.from,
            settledAt: page.from,
            amount: 1000,
            currency: 'usd',
            product: 'subscription',
            expectedCredits: null,
            owner: { id: 'org1', type: 'Organization' },
            rows: [
              {
                id: 'tx1',
                type: 'subscription',
                credits: 100,
                ownerId: 'org1',
                ownerType: 'Organization',
                createdAt: page.from,
              },
            ],
            refunds: [],
            dispute: null,
            livemode: false,
          },
        ],
      },
    });
    renderReview();
    expect(await screen.findByTestId('payment-review-row')).toHaveTextContent('Historical entitlement unknown');
    expect(screen.getByTestId('payment-review-owner-link')).toHaveAttribute(
      'href',
      '/admin?tab=organizations&orgId=org1'
    );
    expect(screen.getByTestId('payment-review-provider-link')).toHaveAttribute(
      'href',
      'https://dashboard.stripe.com/test/payments/pi_1'
    );
    expect(screen.getByTestId('payment-review-timeline')).toHaveTextContent('tx1');
  });
});
