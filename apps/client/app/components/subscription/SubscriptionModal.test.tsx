import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { SubscriptionOwnerType, SubscriptionSource } from '@client/lib/subscriptions/types';
import type { IUserSubscription } from '@client/lib/userSubscriptions/types';
import { ORGANIZATION_SUBSCRIPTION_PRICE_ID } from '@client/lib/subscriptions/constants';
import SubscriptionModal from './SubscriptionModal';

/**
 * The modal is where the delinquent row reaches the plan card: it filters the raw
 * subscription list down to non-terminal rows, marks the matching card as the current
 * plan and hands the same list to the button. Reverting that filter to
 * `status === 'active'` is invisible to every other test in the suite, so these
 * assertions are the ones that fail when the reachability fix is undone.
 */

const PRICE_ID = 'price_pro';
process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_PROD = PRICE_ID;

const cancelMutate = vi.fn();
const subscribeMutate = vi.fn();
const changeMutate = vi.fn();
const portalMutate = vi.fn();
const USER_ID = 'user_1';

let subscriptions: IUserSubscription[] = [];
let teamPriceActive = true;

vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useGetSubscriptions: () => ({ data: subscriptions, isPending: false }),
  useSubscribePlan: () => ({ mutate: (...args: unknown[]) => subscribeMutate(...args), isPending: false }),
  useCancelSubscription: () => ({ mutate: (...args: unknown[]) => cancelMutate(...args), isPending: false }),
  useChangeSubscription: () => ({ mutate: (...args: unknown[]) => changeMutate(...args), isPending: false }),
}));

vi.mock('@client/app/hooks/data/stripe', () => ({
  useGetSubscriptionPlans: () => ({
    data: [
      { id: PRICE_ID, active: true, unit_amount: 1500 },
      ...(teamPriceActive ? [{ id: ORGANIZATION_SUBSCRIPTION_PRICE_ID, active: true, unit_amount: 3000 }] : []),
    ],
    isPending: false,
  }),
  useStripePortal: () => ({ mutate: (...args: unknown[]) => portalMutate(...args), isPending: false }),
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: USER_ID } }),
}));

let settingValues: Record<string, unknown> = {};

vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => settingValues[key] ?? false,
  useConfig: () => ({ data: { seedStageName: 'production' } }),
}));

vi.mock('@client/app/components/organizations/CreateTeamModal', () => ({
  useCreateTeamModal: (selector: (state: { open: () => void }) => unknown) => selector({ open: vi.fn() }),
}));

vi.mock('@client/app/hooks/useAnswerCostReference', () => ({
  useAnswerCostReference: () => ({ modelName: 'Claude 5.5 Sonnet', creditsPerAnswer: 54 }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { credits?: string }) => (opts?.credits ? `${key}:${opts.credits}` : key),
  }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

/** The modal reads only these fields; the mongo plumbing the interface carries is irrelevant. */
const subRow = (overrides: Partial<IUserSubscription> = {}) =>
  ({
    subscriptionId: 'sub_1',
    priceId: PRICE_ID,
    status: 'active',
    canceledAt: null,
    periodStartsAt: new Date('2026-01-01T00:00:00Z'),
    periodEndsAt: new Date('2026-02-01T00:00:00Z'),
    ...overrides,
  }) as unknown as IUserSubscription;

const renderModal = () =>
  render(
    <TestWrapper>
      <SubscriptionModal open onClose={vi.fn()} />
    </TestWrapper>
  );

describe('SubscriptionModal - Team tab', () => {
  beforeEach(() => {
    subscriptions = [];
    teamPriceActive = true;
    settingValues = { enableTeamPlan: true };
  });

  it('opens the Business tab, so Team is on offer here as well as from Teams > Create Team', async () => {
    renderModal();

    const tab = screen.getByRole('tab', { name: 'subscription_modal.business' });
    expect(tab).not.toHaveAttribute('aria-disabled', 'true');

    await userEvent.setup({ delay: null }).click(tab);

    // 4 seats x $30 from the mocked Stripe price, not a hardcoded figure.
    expect(screen.getByText(/\$120\.00/)).toBeInTheDocument();
    expect(screen.getByText('$30.00 per seat per month, 4-seat minimum')).toBeInTheDocument();
    expect(screen.getByTestId('subscription-modal-create-team-btn')).toBeEnabled();
    expect(screen.queryByTestId('subscription-modal-team-unavailable')).not.toBeInTheDocument();
  });

  it('disables the Business tab with a visible, accessible reason when enableTeamPlan is off', async () => {
    settingValues = { enableTeamPlan: false };
    renderModal();

    // The reason is described by, not part of, the tab, so the name stays 'Business'.
    const tab = screen.getByRole('tab', { name: 'subscription_modal.business' });
    expect(tab).toHaveAttribute('aria-disabled', 'true');

    // The tab itself carries the reason; there is no extra tab stop around it.
    const reasonId = tab.getAttribute('aria-describedby');
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId as string)).toHaveTextContent('Team plans are not available right now.');

    const wrapper = screen.getByTestId('subscription-modal-business-tab-wrapper');
    expect(wrapper).not.toHaveAttribute('tabindex');
    await userEvent.setup({ delay: null }).hover(wrapper);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Team plans are not available right now.');

    // The Team card is not reachable.
    expect(screen.queryByTestId('subscription-modal-create-team-btn')).not.toBeInTheDocument();
  });

  it('drops the Team card when the flag flips off while the Business tab is open, and stays on Personal when it returns', async () => {
    const view = renderModal();
    await userEvent.setup({ delay: null }).click(screen.getByTestId('subscription-modal-business-tab'));
    expect(screen.getByTestId('subscription-modal-create-team-btn')).toBeEnabled();

    settingValues = { enableTeamPlan: false };
    view.rerender(
      <TestWrapper>
        <SubscriptionModal open onClose={vi.fn()} />
      </TestWrapper>
    );

    expect(screen.queryByTestId('subscription-modal-create-team-btn')).not.toBeInTheDocument();

    // The stored selection fell back with the gate; turning the flag back on must not pull the view to
    // Business without a click.
    settingValues = { enableTeamPlan: true };
    view.rerender(
      <TestWrapper>
        <SubscriptionModal open onClose={vi.fn()} />
      </TestWrapper>
    );

    expect(screen.queryByTestId('subscription-modal-create-team-btn')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subscribe to Professional' })).toBeInTheDocument();

    // ...and the user can still pick Business once the gate is back on.
    await userEvent.setup({ delay: null }).click(screen.getByTestId('subscription-modal-business-tab'));
    expect(screen.getByTestId('subscription-modal-create-team-btn')).toBeEnabled();
  });

  it('leaves the Business tab enabled and unexplained when enableTeamPlan is on', () => {
    renderModal();

    expect(screen.getByRole('tab', { name: 'subscription_modal.business' })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    );
    expect(screen.getByTestId('subscription-modal-business-tab')).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText('Team plans are not available right now.')).not.toBeInTheDocument();
  });

  it('says why Team cannot be bought when its Stripe price is not live, instead of hiding the tab', async () => {
    teamPriceActive = false;
    renderModal();

    await userEvent.setup({ delay: null }).click(screen.getByRole('tab', { name: 'subscription_modal.business' }));

    expect(screen.getByTestId('subscription-modal-create-team-btn')).toBeDisabled();
    expect(screen.getByTestId('subscription-modal-team-unavailable')).toBeInTheDocument();
    expect(screen.getByText('4-seat minimum')).toBeInTheDocument();
  });

  it('quotes seats, price and pool size from the admin team plan settings', async () => {
    settingValues = { enableTeamPlan: true, teamPlanMinSeats: 2, teamPlanCreditsPerSeat: 1000 };
    renderModal();

    await userEvent.setup({ delay: null }).click(screen.getByRole('tab', { name: 'subscription_modal.business' }));

    expect(screen.getByText(/\$60\.00/)).toBeInTheDocument();
    expect(screen.getByText('2 team member accounts included')).toBeInTheDocument();
    expect(screen.getByText('subscription_modal.credits_per_month:2,000')).toBeInTheDocument();
    expect(screen.getByTestId('plan-card-answers-estimate')).toHaveTextContent(
      /^Estimate: about 37 answers on Claude 5\.5 Sonnet/
    );
  });
});

describe('SubscriptionModal', () => {
  beforeEach(() => {
    subscriptions = [];
    teamPriceActive = true;
    settingValues = { enableTeamPlan: true };
    cancelMutate.mockReset();
    subscribeMutate.mockReset();
    changeMutate.mockReset();
    portalMutate.mockReset();
    sessionStorage.clear();
  });

  it('says every account starts with free credits rather than claiming there is no free tier', () => {
    settingValues = { defaultFreeCredits: 5000 };
    renderModal();

    expect(screen.getByTestId('subscription-modal-starter-credits')).toHaveTextContent(
      'subscription_modal.starter_credits'
    );
    expect(screen.queryByText(/no_free_tier/)).not.toBeInTheDocument();
  });

  it('makes no starter-credits claim when sign-ups are granted nothing', () => {
    settingValues = { defaultFreeCredits: 0 };
    renderModal();

    expect(screen.queryByTestId('subscription-modal-starter-credits')).not.toBeInTheDocument();
    expect(screen.getByText(/subscription_modal.credits_rollover/)).toBeInTheDocument();
  });

  it('estimates how far the Professional credits go on a mid-tier model', () => {
    renderModal();

    expect(screen.getByTestId('plan-card-answers-estimate')).toHaveTextContent(
      /^Estimate: about 920 answers on Claude 5\.5 Sonnet, at about 4,000 tokens in and 1,000 out per answer\./
    );
  });

  it('lists only Professional features a user can find in the app', () => {
    renderModal();

    expect(screen.queryByText(/Phi-4/)).not.toBeInTheDocument();
    expect(screen.queryByText(/prompt engineering tools/)).not.toBeInTheDocument();
    expect(screen.queryByText(/cost optimization/)).not.toBeInTheDocument();
  });

  it('does not badge a lone plan as Most Popular on either tab', async () => {
    renderModal();

    expect(screen.getByRole('button', { name: 'Subscribe to Professional' })).toBeInTheDocument();
    expect(screen.queryByTestId('plan-card-popular-badge')).not.toBeInTheDocument();

    await userEvent.setup({ delay: null }).click(screen.getByRole('tab', { name: 'subscription_modal.business' }));

    expect(screen.getByTestId('subscription-modal-create-team-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('plan-card-popular-badge')).not.toBeInTheDocument();
  });

  it('shows a delinquent plan as the current plan and lets the user cancel it', async () => {
    subscriptions = [subRow({ status: 'past_due' })];

    renderModal();

    // The payment-issue copy, not the healthy "renews on" line.
    expect(screen.getByText('subscriptions.payment_issue')).toBeInTheDocument();

    await userEvent
      .setup({ delay: null })
      .click(screen.getByRole('button', { name: 'Cancel Professional subscription' }));

    expect(cancelMutate).toHaveBeenCalledWith(PRICE_ID);
  });

  it('offers Subscribe, not Change, when the only plan the user holds is delinquent', () => {
    // A grandfathered/legacy price: the delinquent row is on a different price than the
    // one plan the modal renders. Change would 400 on the server's active-only lookup.
    subscriptions = [subRow({ status: 'past_due', priceId: 'price_legacy' })];

    renderModal();

    expect(screen.getByRole('button', { name: 'Subscribe to Professional' })).toBeEnabled();
  });

  it('still offers Change when the user holds a plan in good standing at another price', () => {
    subscriptions = [subRow({ status: 'active', priceId: 'price_legacy' })];

    renderModal();

    expect(screen.getByRole('button', { name: 'Change subscription to Professional' })).toBeEnabled();
  });

  it('ignores a terminal row, so a finished plan is not shown as current', () => {
    subscriptions = [subRow({ status: 'canceled' })];

    renderModal();

    expect(screen.queryByText('subscriptions.payment_issue')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subscribe to Professional' })).toBeEnabled();
  });

  it.each([
    ['stale delinquent row first', 'stale-first'],
    ['active row first', 'active-first'],
  ])('does not paint a healthy plan as payment-failed (%s)', (_label, order) => {
    // A re-subscribe after a failed renewal leaves the old past_due row behind at the
    // same price, and the subscription list is unsorted. First-match would show the
    // paying user a red payment-failure banner on their own plan.
    const stale = subRow({ status: 'past_due', subscriptionId: 'sub_stale' });
    const live = subRow({ status: 'active', subscriptionId: 'sub_live' });
    subscriptions = order === 'stale-first' ? [stale, live] : [live, stale];

    renderModal();

    expect(screen.queryByText('subscriptions.payment_issue')).not.toBeInTheDocument();
    expect(screen.getByText('subscription_modal.subscription_renewal')).toBeInTheDocument();
  });

  describe('Manage Subscription', () => {
    const manageButton = () => screen.queryByTestId('plan-card-manage-subscription-btn');

    it('opens the Stripe portal for an active subscriber and returns them to the page they left', async () => {
      subscriptions = [subRow({ status: 'active' })];
      window.history.replaceState({}, '', '/notebooks?view=grid');

      renderModal();

      const button = manageButton();
      expect(button).toHaveTextContent('profile.manage_subscription');
      expect(button).toHaveClass('MuiButton-variantOutlined');

      await userEvent.setup({ delay: null }).click(button!);

      expect(portalMutate).toHaveBeenCalledWith(
        { ownerType: SubscriptionOwnerType.User, ownerId: USER_ID },
        expect.objectContaining({ onSuccess: expect.any(Function) })
      );
      // The return key is written only once the portal session exists, never on click.
      expect(sessionStorage.getItem('__stripe_return')).toBeNull();
      portalMutate.mock.calls[0][1].onSuccess();
      expect(sessionStorage.getItem('__stripe_return')).toBe('/notebooks?view=grid');
    });

    it('makes Manage the primary action for a delinquent subscriber and keeps Cancel', () => {
      subscriptions = [subRow({ status: 'past_due' })];

      renderModal();

      expect(screen.getByText('subscriptions.payment_issue')).toBeInTheDocument();
      expect(manageButton()).toHaveClass('MuiButton-variantSolid');
      expect(screen.getByRole('button', { name: 'Cancel Professional subscription' })).toHaveClass(
        'MuiButton-variantOutlined'
      );
    });

    it('stays available on a plan that is canceled but not yet ended, so the user can resume it', () => {
      subscriptions = [subRow({ status: 'active', canceledAt: new Date('2026-01-15T00:00:00Z') })];

      renderModal();

      expect(manageButton()).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Subscription ends on/ })).toBeDisabled();
    });

    it('is not offered to a non-subscriber', () => {
      subscriptions = [];

      renderModal();

      expect(manageButton()).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Subscribe to Professional' })).toBeEnabled();
    });

    it('is not offered on a plan card the user does not hold', () => {
      subscriptions = [subRow({ status: 'active', priceId: 'price_legacy' })];

      renderModal();

      expect(manageButton()).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Change subscription to Professional' })).toBeEnabled();
    });

    it('is not offered on an admin-granted plan, which the portal refuses', () => {
      subscriptions = [subRow({ subscriptionId: 'admin_grant_x', source: SubscriptionSource.AdminGrant })];

      renderModal();

      expect(manageButton()).not.toBeInTheDocument();
    });
  });
});
