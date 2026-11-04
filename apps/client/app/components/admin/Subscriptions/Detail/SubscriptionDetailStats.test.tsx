import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AdminSubscriptionStripeState } from '@client/app/hooks/data/adminSubscriptionDetail';
import { SubscriptionDetailStats } from './SubscriptionDetailStats';
import {
  STRIPE_ROW,
  SubscriptionTestWrapper,
  buildDetail,
  buildStripeData,
  buildStripeState,
} from './subscriptionDetailTestUtils';

const lifetime = (stripe: AdminSubscriptionStripeState, comp = false) => {
  render(<SubscriptionDetailStats detail={buildDetail(comp ? {} : { subscription: STRIPE_ROW })} stripe={stripe} />, {
    wrapper: SubscriptionTestWrapper,
  });
  return screen.getByTestId('subscription-detail-lifetime-paid').closest('[data-testid="admin-stat-tile"]');
};

describe('SubscriptionDetailStats Lifetime paid', () => {
  it('is a dash while loading and when Stripe failed', () => {
    expect(lifetime(buildStripeState({ data: undefined, isLoading: true }))).toHaveTextContent('Lifetime paid-');
  });

  it('is a dash on error', () => {
    expect(lifetime(buildStripeState({ data: undefined, isError: true }))).toHaveTextContent('Lifetime paid-');
  });

  it('shows the paid total', () => {
    const tile = lifetime(
      buildStripeState({ data: buildStripeData({ lifetimePaid: [{ amount: 24000, currency: 'usd' }] }) })
    );
    expect(tile).toHaveTextContent('$240.00');
  });

  it('notes other currencies and a truncated history', () => {
    const tile = lifetime(
      buildStripeState({
        data: buildStripeData({
          lifetimePaid: [
            { amount: 1000, currency: 'usd' },
            { amount: 500, currency: 'eur' },
          ],
          invoicesTruncated: true,
        }),
      })
    );
    expect(tile).toHaveTextContent('+1 other currency, Latest 300 invoices');
  });

  it('says Comped plan for a comp', () => {
    expect(lifetime(buildStripeState({ data: undefined }), true)).toHaveTextContent('Comped plan');
  });
});
