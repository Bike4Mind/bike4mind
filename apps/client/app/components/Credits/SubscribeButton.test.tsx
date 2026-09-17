import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IUserSubscription } from '@client/lib/userSubscriptions/types';
import SubscribeButton from './SubscribeButton';

const cancelMutate = vi.fn();

vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useSubscribePlan: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelSubscription: () => ({ mutate: (...args: unknown[]) => cancelMutate(...args), isPending: false }),
  useChangeSubscription: () => ({ mutate: vi.fn(), isPending: false }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

/**
 * The button reads only these fields; the mongo document plumbing the interface
 * carries is irrelevant to what it renders.
 */
const subRow = (overrides: Partial<IUserSubscription> = {}) =>
  ({
    subscriptionId: 'sub_1',
    priceId: 'price_pro',
    status: 'active',
    canceledAt: null,
    periodStartsAt: new Date('2026-01-01T00:00:00Z'),
    periodEndsAt: new Date('2026-02-01T00:00:00Z'),
    ...overrides,
  }) as unknown as IUserSubscription;

const renderButton = (subscriptions: IUserSubscription[], priceId = 'price_pro') =>
  render(
    <TestWrapper>
      <SubscribeButton priceId={priceId} cancellableSubscriptions={subscriptions} />
    </TestWrapper>
  );

describe('SubscribeButton', () => {
  beforeEach(() => {
    cancelMutate.mockReset();
  });

  // The issue's repro, as far as this component is concerned: a dunned row in the list
  // has to offer Cancel. The button is deliberately status-agnostic - it decides on
  // priceId alone, and it is the parent that filters the list down to non-terminal rows.
  // So this pins "the button does the right thing GIVEN a dunned row"; that the modal
  // actually supplies one is pinned in SubscriptionModal.test.tsx.
  it.each(['past_due', 'unpaid'] as const)('offers Cancel for a %s row and cancels that plan', async status => {
    renderButton([subRow({ status })]);

    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Cancel Subscription' }));

    expect(cancelMutate).toHaveBeenCalledWith('price_pro');
  });

  it('offers Subscribe when there is nothing cancellable', () => {
    renderButton([]);

    expect(screen.getByRole('button', { name: 'Subscribe' })).toBeEnabled();
  });

  it('offers Change for another plan while the user keeps theirs', () => {
    renderButton([subRow({ status: 'active' })], 'price_other');

    expect(screen.getByRole('button', { name: 'Change Subscription' })).toBeEnabled();
    expect(cancelMutate).not.toHaveBeenCalled();
  });

  it('offers Subscribe, not Change, when the only plan the user holds is delinquent', () => {
    // /api/subscriptions/change resolves through the active-only lookup, so Change would
    // 400 for this user. Subscribe is the truth - and is what they saw before the
    // delinquent row was included in this list.
    renderButton([subRow({ status: 'past_due' })], 'price_other');

    expect(screen.getByRole('button', { name: 'Subscribe' })).toBeEnabled();
  });

  it('shows when a scheduled cancellation ends the plan instead of offering to cancel again', () => {
    renderButton([subRow({ status: 'active', canceledAt: new Date('2026-01-10T00:00:00Z') })]);

    expect(screen.getByRole('button', { name: /Subscription ends on February 1, 2026/ })).toBeDisabled();
  });

  it("cancels the live plan rather than showing the stale row's end date", async () => {
    // A period-end cancel followed by a re-subscribe can leave a canceledAt-bearing
    // past_due row beside the active one at the same price. First-match would render
    // that old row's end date and hide the cancel action from a paying user.
    renderButton([
      subRow({ status: 'past_due', subscriptionId: 'sub_stale', canceledAt: new Date('2026-01-10T00:00:00Z') }),
      subRow({ status: 'active', subscriptionId: 'sub_live' }),
    ]);

    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Cancel Subscription' }));

    expect(cancelMutate).toHaveBeenCalledWith('price_pro');
  });
});
