// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument } from '@bike4mind/common';
import { isDelinquentSubscriptionStatus, SubscriptionSource } from '@bike4mind/server-utils/lib/subscriptions/types';
import {
  ORGANIZATION_SUBSCRIPTION_PRICE_ID,
  TEAM_PLAN_UNAVAILABLE_MESSAGE,
} from '@bike4mind/server-utils/lib/subscriptions/constants';
import { ExternalLinks } from '@client/app/utils/externalLinks';
import OrganizationBillingSection from './OrganizationBillingSection';

/**
 * The org surface read active-only, so an org whose subscription went past_due got no row: the
 * Billing Portal button vanished (the only route to fix the card or cancel) while "Subscribe Now"
 * appeared - and the checkout guard was itself active-only, so that second subscription was really
 * created. These pin the delinquent render: portal present, no self-serve subscribe, no seat change.
 */

const subscriptionsData = vi.hoisted(() => ({ current: [] as unknown[] }));
const updateSeatsMutate = vi.hoisted(() => vi.fn());
const subscribeMutate = vi.hoisted(() => vi.fn());
const teamPlanFlag = vi.hoisted(() => ({ current: true }));
const plansData = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useGetSubscriptionsByOwner: () => ({ data: subscriptionsData.current, isPending: false }),
  useSubscribeTeamPlan: () => ({ mutateAsync: subscribeMutate, isPending: false }),
  useUpdateSubscriptionSeats: () => ({ mutateAsync: updateSeatsMutate, isPending: false, error: null }),
}));

vi.mock('@client/app/hooks/data/teamPlanSettings', () => ({
  useTeamSeatLimits: () => ({ minSeats: 4, maxSeats: 100 }),
  useTeamPlanAvailable: () => teamPlanFlag.current,
}));
vi.mock('@client/app/hooks/data/stripe', () => ({
  useStripePortal: () => ({ mutate: vi.fn(), isPending: false }),
  useGetSubscriptionPlans: () => ({
    data: plansData.current,
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

// The stripe price and the Team-plan flag feed every block, and the seat modal only renders when a
// price is present. Reset them per test so a block run on its own (or reordered) still sees them.
beforeEach(() => {
  subscriptionsData.current = [];
  teamPlanFlag.current = true;
  plansData.current = [{ id: ORGANIZATION_SUBSCRIPTION_PRICE_ID, unit_amount: 1000 }];
});

describe('OrganizationBillingSection - delinquent organization', () => {
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

describe('OrganizationBillingSection - seat editor', () => {
  // Seat limits are 4..100 and the org has one member besides the owner, so the floor is 4.
  const openSeatEditor = async () => {
    subscriptionsData.current = [row('active')];
    updateSeatsMutate.mockReset();
    updateSeatsMutate.mockResolvedValue(undefined);
    renderSection();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('button', { name: /manage seats/i }));
    const input = screen.getByTestId('organization-billing-seats-input') as HTMLInputElement;
    return { user, input };
  };

  it('accepts a typed seat count and prices it', async () => {
    const { user, input } = await openSeatEditor();
    await user.clear(input);
    await user.type(input, '12');

    expect(input.value).toBe('12');
    expect(screen.getByText('$120/month')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Update Seats' }));
    expect(updateSeatsMutate).toHaveBeenCalledWith({ organizationId: 'org1', seats: 12 });
  });

  it.each([
    ['above the maximum', '500'],
    ['below the minimum', '2'],
  ])('flags a value %s and keeps submit disabled, even after blur', async (_name, text) => {
    const { user, input } = await openSeatEditor();
    await user.clear(input);
    await user.type(input, text);
    const submit = screen.getByRole('button', { name: 'Update Seats' });

    expect(screen.getByTestId('organization-billing-seats-input-error').textContent).toBe('Must be between 4 and 100');
    expect(submit.hasAttribute('disabled')).toBe(true);

    await user.tab();
    expect(input.value).toBe(text);
    expect(submit.hasAttribute('disabled')).toBe(true);
  });

  it('does not submit an out-of-range count while the field is still focused', async () => {
    const { user, input } = await openSeatEditor();
    await user.clear(input);
    await user.type(input, '500');
    fireEvent.click(screen.getByRole('button', { name: 'Update Seats' }));

    expect(updateSeatsMutate).not.toHaveBeenCalled();
  });

  it('shows the decrease and maximum warnings for a valid draft', async () => {
    const { user, input } = await openSeatEditor();
    await user.clear(input);
    await user.type(input, '4');
    expect(screen.getByText(/Decreasing seats will not affect/)).toBeTruthy();

    await user.clear(input);
    await user.type(input, '100');
    expect(screen.getByText(/Maximum number of seats/)).toBeTruthy();
  });

  it('shows no decrease or maximum warning for a partial or invalid draft', async () => {
    const { user, input } = await openSeatEditor();
    await user.clear(input);
    await user.type(input, '1');

    expect(screen.queryByText(/Decreasing seats will not affect/)).toBeNull();
    expect(screen.queryByText(/Maximum number of seats/)).toBeNull();

    await user.clear(input);
    await user.type(input, '500');
    expect(screen.queryByText(/Maximum number of seats/)).toBeNull();
  });

  it('disables the submit button while the field is empty', async () => {
    const { user, input } = await openSeatEditor();
    const submit = screen.getByRole('button', { name: 'Update Seats' });
    expect(submit.hasAttribute('disabled')).toBe(false);

    await user.clear(input);
    expect(submit.hasAttribute('disabled')).toBe(true);

    await user.tab();
    expect(submit.hasAttribute('disabled')).toBe(true);
  });

  it('links custom billing to the sales contact in a new tab', async () => {
    await openSeatEditor();
    const link = screen.getByTestId('organization-billing-contact-sales-link') as HTMLAnchorElement;

    expect(link.getAttribute('href')).toBe(ExternalLinks.support);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('OrganizationBillingSection - subscribe mode', () => {
  const openSubscribe = async () => {
    subscriptionsData.current = [];
    subscribeMutate.mockReset();
    subscribeMutate.mockResolvedValue({});
    renderSection();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('button', { name: /subscribe now/i }));
    const input = screen.getByTestId('organization-billing-seats-input') as HTMLInputElement;
    return { user, input, submit: screen.getByRole('button', { name: 'Subscribe' }) };
  };

  it('sends the typed seat count to checkout as the quantity', async () => {
    const { user, input, submit } = await openSubscribe();
    await user.clear(input);
    await user.type(input, '12');
    await user.click(submit);

    expect(subscribeMutate).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 12, organizationId: 'org1', priceId: ORGANIZATION_SUBSCRIPTION_PRICE_ID })
    );
  });

  it('keeps Subscribe disabled for an out-of-range count, even after blur, and never calls checkout', async () => {
    const { user, input, submit } = await openSubscribe();
    await user.clear(input);
    await user.type(input, '500');
    expect(submit.hasAttribute('disabled')).toBe(true);

    await user.tab();
    expect(submit.hasAttribute('disabled')).toBe(true);

    fireEvent.click(submit);
    expect(subscribeMutate).not.toHaveBeenCalled();
  });

  it('keeps Subscribe disabled while the field is empty', async () => {
    const { user, input, submit } = await openSubscribe();
    await user.clear(input);
    expect(submit.hasAttribute('disabled')).toBe(true);

    await user.tab();
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(submit);
    expect(subscribeMutate).not.toHaveBeenCalled();
  });
});

describe('OrganizationBillingSection - Team plan gate', () => {
  it('disables Subscribe Now and states why when Team plans are off', () => {
    teamPlanFlag.current = false;

    renderSection();

    const btn = screen.getByTestId('organization-billing-subscribe-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByLabelText(TEAM_PLAN_UNAVAILABLE_MESSAGE)).toBeTruthy();
  });

  it('enables Subscribe Now when Team plans are on and a price is present', () => {
    renderSection();

    const btn = screen.getByTestId('organization-billing-subscribe-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(screen.queryByLabelText(TEAM_PLAN_UNAVAILABLE_MESSAGE)).toBeNull();
  });
});
