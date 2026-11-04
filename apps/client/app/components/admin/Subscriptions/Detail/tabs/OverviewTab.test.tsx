import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { AdminSubscriptionDetail } from '@client/app/utils/adminSubscriptionDetail';
import { OverviewTab } from './OverviewTab';
import {
  OWNER_ID,
  STRIPE_ROW,
  SubscriptionTestWrapper,
  buildDetail,
  buildRow,
  buildStripeData,
  buildStripeState,
} from '../subscriptionDetailTestUtils';
import type { AdminSubscriptionStripeState } from '@client/app/hooks/data/adminSubscriptionDetail';

const MINUS = '\u2212';

const setup = (detail: AdminSubscriptionDetail, stripe: AdminSubscriptionStripeState = buildStripeState()) => {
  const handlers = { onOpenOwner: vi.fn(), onOpenSubscription: vi.fn(), onOpenLedger: vi.fn() };
  render(<OverviewTab detail={detail} stripe={stripe} {...handlers} />, { wrapper: SubscriptionTestWrapper });
  return handlers;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('OverviewTab', () => {
  it('shows a comp with its grant facts and no Payment card', () => {
    setup(buildDetail());
    expect(screen.getByTestId('subscription-detail-source')).toHaveTextContent('Comp');
    expect(screen.getByTestId('subscription-detail-plan-card')).toHaveTextContent('Pilot');
    expect(screen.queryByTestId('subscription-detail-payment-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('subscription-detail-seats-card')).not.toBeInTheDocument();
  });

  it('shows an Unknown price chip on a Stripe row', () => {
    setup(buildDetail({ subscription: { ...STRIPE_ROW, plan: { priceId: 'price_x', name: null, interval: null } } }));
    expect(screen.getByTestId('subscription-detail-payment-card')).toBeInTheDocument();
    expect(screen.getByTestId('subscription-detail-unknown-price-chip')).toHaveTextContent('Unknown price');
  });

  it('lists recent grants as signed credits and opens the owner ledger', () => {
    const { onOpenLedger } = setup(
      buildDetail({
        credits: {
          defaultPerCycle: 1000,
          customPerCycle: 2500,
          effectivePerCycle: 2500,
          recentGrants: [
            { id: 'g1', credits: 2500, createdAt: '2026-10-01T00:00:00.000Z' },
            { id: 'g2', credits: -400, createdAt: '2026-09-01T00:00:00.000Z' },
          ],
        },
      })
    );
    expect(screen.getByTestId('subscription-detail-credits-override')).toHaveTextContent('2,500');
    const grants = screen.getByTestId('subscription-detail-recent-grants');
    expect(grants).toHaveTextContent('+2,500');
    expect(grants).toHaveTextContent(`${MINUS}400`);
    fireEvent.click(screen.getByTestId('subscription-detail-open-ledger-btn'));
    expect(onOpenLedger).toHaveBeenCalledWith(OWNER_ID);
  });

  it('flags a second live subscription as a possible duplicate and links to it', () => {
    const { onOpenSubscription } = setup(
      buildDetail({
        otherSubscriptions: [buildRow({ id: 'other-live', plan: { priceId: 'p', name: 'Team', interval: 'monthly' } })],
      })
    );
    const row = screen.getByTestId('subscription-detail-other-subscription');
    expect(within(row).getByTestId('subscription-detail-duplicate-chip')).toBeInTheDocument();
    fireEvent.click(within(row).getByTestId('subscription-detail-other-subscription-link'));
    expect(onOpenSubscription).toHaveBeenCalledWith('other-live');
  });

  it('shows seats for an organization and flags a seat count that differs from paid', () => {
    setup(
      buildDetail({
        seats: { paid: 5, organizationSeats: 8, members: 4, min: 2, max: 100 },
      })
    );
    expect(screen.getByTestId('subscription-detail-seat-mismatch-chip')).toBeInTheDocument();
  });
});

describe('OverviewTab Payment card', () => {
  const stripeDetail = () => buildDetail({ subscription: STRIPE_ROW });

  it('shows the card, latest invoice and next invoice', () => {
    setup(
      stripeDetail(),
      buildStripeState({
        data: buildStripeData({
          invoices: [
            {
              id: 'in_1',
              number: 'N-1',
              createdAt: '2026-10-01T00:00:00.000Z',
              amountDue: 2000,
              amountPaid: 2000,
              currency: 'usd',
              status: 'paid',
              paidAt: null,
              attempts: 1,
              hostedInvoiceUrl: null,
              creditsGranted: null,
            },
          ],
          upcoming: { amount: 2500, currency: 'usd', at: '2026-12-01T00:00:00.000Z' },
        }),
      })
    );
    expect(screen.getByTestId('subscription-detail-payment-card-number')).toHaveTextContent('Visa ending 4242');
    expect(screen.getByTestId('subscription-detail-payment-expiry')).toHaveTextContent('12/2099');
    expect(screen.queryByTestId('subscription-detail-card-expiring-chip')).not.toBeInTheDocument();
    expect(screen.getByTestId('subscription-detail-latest-invoice')).toHaveTextContent('Paid');
    expect(screen.getByTestId('subscription-detail-next-invoice')).toHaveTextContent('$25.00 on 1 Dec 2026');
  });

  it('warns when the card expires within 30 days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
    setup(
      stripeDetail(),
      buildStripeState({
        data: buildStripeData({
          paymentMethod: {
            type: 'card',
            brand: 'visa',
            last4: '4242',
            expMonth: 11,
            expYear: 2026,
          },
        }),
      })
    );
    expect(screen.getByTestId('subscription-detail-card-expiring-chip')).toHaveTextContent('Expires soon');
    expect(screen.queryByTestId('subscription-detail-card-expired-chip')).not.toBeInTheDocument();
  });

  it('flags a card whose expiry month has passed as Expired', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
    setup(
      stripeDetail(),
      buildStripeState({
        data: buildStripeData({
          paymentMethod: { type: 'card', brand: 'visa', last4: '4242', expMonth: 9, expYear: 2026 },
        }),
      })
    );
    expect(screen.getByTestId('subscription-detail-card-expired-chip')).toHaveTextContent('Expired');
    expect(screen.queryByTestId('subscription-detail-card-expiring-chip')).not.toBeInTheDocument();
  });

  it('keeps every Mongo card when Stripe is down, and offers Try again', () => {
    const refetchFresh = vi.fn();
    setup(stripeDetail(), buildStripeState({ data: undefined, isError: true, refetchFresh }));
    expect(screen.getByTestId('subscription-detail-payment-error')).toHaveTextContent("Couldn't reach Stripe");
    expect(screen.getByTestId('subscription-detail-plan-card')).toBeInTheDocument();
    expect(screen.getByTestId('subscription-detail-credits-card')).toBeInTheDocument();
    expect(screen.getByTestId('subscription-detail-owner-card')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetchFresh).toHaveBeenCalled();
  });

  it('shows a skeleton while loading and the docs link when Stripe is not configured', () => {
    const { unmount } = render(
      <OverviewTab
        detail={stripeDetail()}
        stripe={buildStripeState({ data: undefined, isLoading: true })}
        onOpenOwner={vi.fn()}
        onOpenSubscription={vi.fn()}
        onOpenLedger={vi.fn()}
      />,
      { wrapper: SubscriptionTestWrapper }
    );
    expect(screen.getByTestId('subscription-detail-payment-loading')).toBeInTheDocument();
    unmount();
    setup(stripeDetail(), buildStripeState({ data: { stripeConfigured: false } }));
    expect(screen.getByTestId('subscription-detail-payment-self-host-docs-link')).toHaveAttribute(
      'href',
      expect.stringContaining('docs.bike4mind.com')
    );
  });
});
