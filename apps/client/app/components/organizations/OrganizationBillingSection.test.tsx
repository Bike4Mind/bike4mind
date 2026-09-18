// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument } from '@bike4mind/common';
import { isDelinquentSubscriptionStatus, SubscriptionSource } from '@client/lib/subscriptions/types';
import { ORGANIZATION_SUBSCRIPTION_PRICE_ID } from '@client/lib/subscriptions/constants';
import OrganizationBillingSection from './OrganizationBillingSection';

/**
 * The org surface read active-only, so an org whose subscription went past_due got no row: the
 * Billing Portal button vanished (the only route to fix the card or cancel) while "Subscribe Now"
 * appeared - and the checkout guard was itself active-only, so that second subscription was really
 * created. These pin the delinquent render: portal present, no self-serve subscribe, no seat change.
 */

const subscriptionsData = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useGetSubscriptionsByOwner: () => ({ data: subscriptionsData.current, isPending: false }),
  useSubscribeTeamPlan: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateSubscriptionSeats: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}));

vi.mock('@client/app/hooks/data/stripe', () => ({
  useStripePortal: () => ({ mutate: vi.fn(), isPending: false }),
  useGetSubscriptionPlans: () => ({
    data: [{ id: ORGANIZATION_SUBSCRIPTION_PRICE_ID, unit_amount: 1000 }],
    isPending: false,
  }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });

const org = {
  id: 'org1',
  name: 'Acme',
  seats: 5,
  users: [{ userId: 'u1' }],
} as unknown as IOrganizationDocument;

const row = (status: string) => ({
  ownerType: 'Organization',
  ownerId: 'org1',
  subscriptionId: `sub_${status}`,
  priceId: ORGANIZATION_SUBSCRIPTION_PRICE_ID,
  status,
  source: SubscriptionSource.Stripe,
  canceledAt: null,
  periodStartsAt: new Date('2026-01-01T00:00:00Z'),
  periodEndsAt: new Date('2026-02-01T00:00:00Z'),
  quantity: 5,
});

const renderSection = () => {
  const wrapper = (children: ReactNode) => <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>;
  return render(wrapper(<OrganizationBillingSection organization={org} />));
};

describe('OrganizationBillingSection - delinquent organization', () => {
  beforeEach(() => {
    subscriptionsData.current = [];
  });

  it('keeps the Billing Portal and hides self-serve subscribe and seat changes', () => {
    subscriptionsData.current = [row('past_due')];

    renderSection();

    expect(screen.getByRole('button', { name: /billing portal/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /subscribe now/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /manage seats/i })).toBeNull();
  });

  it('renders the plan as a payment issue, not a healthy renewal', () => {
    subscriptionsData.current = [row('past_due')];

    renderSection();

    expect(screen.getByText('Payment issue')).toBeTruthy();
    expect(screen.queryByText(/^Renews on/)).toBeNull();
  });

  it('still offers the portal for an unpaid row', () => {
    subscriptionsData.current = [row('unpaid')];

    renderSection();

    expect(screen.getByRole('button', { name: /billing portal/i })).toBeTruthy();
    expect(screen.getByText('Payment issue')).toBeTruthy();
  });

  it('reads an active row as healthy and keeps seat management', () => {
    // The contrast that keeps the assertions above from passing on a component that hides
    // everything: a paid-up org must still show the normal plan state.
    expect(isDelinquentSubscriptionStatus('active')).toBe(false);
    subscriptionsData.current = [row('active')];

    renderSection();

    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByRole('button', { name: /billing portal/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /manage seats/i })).toBeTruthy();
    expect(screen.queryByText('Payment issue')).toBeNull();
  });

  it('still offers Subscribe Now when the org has no subscription at all', () => {
    subscriptionsData.current = [];

    renderSection();

    expect(screen.getByRole('button', { name: /subscribe now/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /billing portal/i })).toBeNull();
  });
});
