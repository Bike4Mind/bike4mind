import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IUserSubscription } from '@client/lib/userSubscriptions/types';
import ProfileDetailTabContent from './ProfileDetailTabContent';

/**
 * The subscription line in the profile is the second surface that has to show a
 * delinquent plan as such, and the only one that picks WHICH row is the user's plan
 * out of an unsorted list. Both decisions are invisible to the rest of the suite:
 * the tab is stubbed out by the one test that reaches the profile screen.
 */

const refreshUser = vi.fn();
const stripePortalMutate = vi.fn();

let subscriptions: IUserSubscription[] = [];

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({
    currentUser: { id: 'user_1', currentCredits: 0, showCreditsUsed: false, currentStorageSize: 0, storageLimit: 0 },
    refreshUser,
  }),
}));

vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useGetSubscriptions: () => ({ data: subscriptions, isPending: false }),
}));

vi.mock('@client/app/hooks/data/stripe', () => ({
  useGetSubscriptionPlans: () => ({ data: [], isPending: false }),
  useStripePortal: () => ({ mutate: (...args: unknown[]) => stripePortalMutate(...args), isPending: false }),
}));

vi.mock('@client/app/hooks/data/user', () => ({
  useToggleShowCreditsUsed: () => ({ mutate: vi.fn() }),
}));

// Children that drag in the editor, the collection browser or another modal; irrelevant
// to the subscription line and expensive to mount.
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@client/app/components/profile/ProfileDetailSection', () => ({ default: () => null }));
vi.mock('@client/app/components/profile/ChangeEmailCard', () => ({ default: () => null }));
vi.mock('@client/app/components/subscription/CreditsModal', () => ({ default: () => null }));
vi.mock('@client/app/components/subscription/SubscriptionModal', () => ({ default: () => null }));
vi.mock('@client/app/components/SquareSlideToggle', () => ({ default: () => null }));
vi.mock('@client/app/components/svgs/icons/Bike4MindIcon', () => ({ default: () => null }));
vi.mock('@client/app/components/ProfileModal/SectionContainer', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

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

const renderTab = () =>
  render(
    <TestWrapper>
      <ProfileDetailTabContent />
    </TestWrapper>
  );

describe('ProfileDetailTabContent subscription line', () => {
  beforeEach(() => {
    subscriptions = [];
    stripePortalMutate.mockReset();
  });

  it('tells a delinquent user their payment failed instead of when the plan renews', () => {
    subscriptions = [subRow({ status: 'past_due' })];

    renderTab();

    expect(screen.getByText('subscriptions.payment_issue')).toBeInTheDocument();
    expect(screen.queryByText('subscriptions.renews_on')).not.toBeInTheDocument();
  });

  it('shows the active plan, not the stale delinquent row, when the user holds both', () => {
    // /api/subscriptions/own is an unsorted find, so the leftover past_due row can come
    // first. Displaying it would report a payment failure for a plan that is healthy.
    subscriptions = [subRow({ subscriptionId: 'sub_stale', status: 'past_due' }), subRow({ status: 'active' })];

    renderTab();

    expect(screen.queryByText('subscriptions.payment_issue')).not.toBeInTheDocument();
    expect(screen.getByText('subscriptions.renews_on')).toBeInTheDocument();
  });
});
