import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { AdminSubscriptionDetail } from '@client/app/utils/adminSubscriptionDetail';
import { OverviewTab } from './OverviewTab';
import { OWNER_ID, STRIPE_ROW, SubscriptionTestWrapper, buildDetail, buildRow } from '../subscriptionDetailTestUtils';

const MINUS = '\u2212';

const setup = (detail: AdminSubscriptionDetail) => {
  const handlers = { onOpenOwner: vi.fn(), onOpenSubscription: vi.fn(), onOpenLedger: vi.fn() };
  render(<OverviewTab detail={detail} {...handlers} />, { wrapper: SubscriptionTestWrapper });
  return handlers;
};

describe('OverviewTab', () => {
  it('shows a comp with its grant facts and no Payment card', () => {
    setup(buildDetail());
    expect(screen.getByTestId('subscription-detail-source')).toHaveTextContent('Comp');
    expect(screen.getByTestId('subscription-detail-plan-card')).toHaveTextContent('Pilot');
    expect(screen.queryByTestId('subscription-detail-payment-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('subscription-detail-seats-card')).not.toBeInTheDocument();
  });

  it('shows the Payment placeholder and an Unknown price chip on a Stripe row', () => {
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
