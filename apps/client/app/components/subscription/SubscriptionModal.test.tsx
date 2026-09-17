import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IUserSubscription } from '@client/lib/userSubscriptions/types';
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

let subscriptions: IUserSubscription[] = [];

vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useGetSubscriptions: () => ({ data: subscriptions, isPending: false }),
  useSubscribePlan: () => ({ mutate: (...args: unknown[]) => subscribeMutate(...args), isPending: false }),
  useCancelSubscription: () => ({ mutate: (...args: unknown[]) => cancelMutate(...args), isPending: false }),
  useChangeSubscription: () => ({ mutate: (...args: unknown[]) => changeMutate(...args), isPending: false }),
}));

vi.mock('@client/app/hooks/data/stripe', () => ({
  useGetSubscriptionPlans: () => ({ data: [{ id: PRICE_ID, active: true, unit_amount: 1500 }], isPending: false }),
  useStripePortal: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: () => false,
  useConfig: () => ({ data: { seedStageName: 'production' } }),
}));

vi.mock('@client/app/components/organizations/CreateTeamModal', () => ({
  useCreateTeamModal: (selector: (state: { open: () => void }) => unknown) => selector({ open: vi.fn() }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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

describe('SubscriptionModal', () => {
  beforeEach(() => {
    subscriptions = [];
    cancelMutate.mockReset();
    subscribeMutate.mockReset();
    changeMutate.mockReset();
  });

  it('shows a delinquent plan as the current plan and lets the user cancel it', async () => {
    subscriptions = [subRow({ status: 'past_due' })];

    renderModal();

    // The payment-issue copy, not the healthy "renews on" line.
    expect(screen.getByText('subscriptions.payment_issue')).toBeInTheDocument();

    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Cancel Subscription' }));

    expect(cancelMutate).toHaveBeenCalledWith(PRICE_ID);
  });

  it('offers Subscribe, not Change, when the only plan the user holds is delinquent', () => {
    // A grandfathered/legacy price: the delinquent row is on a different price than the
    // one plan the modal renders. Change would 400 on the server's active-only lookup.
    subscriptions = [subRow({ status: 'past_due', priceId: 'price_legacy' })];

    renderModal();

    expect(screen.getByRole('button', { name: 'Subscribe' })).toBeEnabled();
  });

  it('still offers Change when the user holds a plan in good standing at another price', () => {
    subscriptions = [subRow({ status: 'active', priceId: 'price_legacy' })];

    renderModal();

    expect(screen.getByRole('button', { name: 'Change Subscription' })).toBeEnabled();
  });

  it('ignores a terminal row, so a finished plan is not shown as current', () => {
    subscriptions = [subRow({ status: 'canceled' })];

    renderModal();

    expect(screen.queryByText('subscriptions.payment_issue')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subscribe' })).toBeEnabled();
  });
});
