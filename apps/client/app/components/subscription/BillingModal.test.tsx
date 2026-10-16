import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IUserSubscription } from '@client/lib/userSubscriptions/types';
import type { BillingView } from '@client/app/utils/billingDeepLink';

const state = vi.hoisted(() => ({
  subscriptions: [] as unknown[],
  subscriptionsPending: false,
  credits: 5000,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));
vi.mock('@client/app/hooks/data/credits', () => ({ useGetCreditTransactions: () => ({ data: [], isPending: false }) }));
vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useGetSubscriptions: () => ({ data: state.subscriptions, isPending: state.subscriptionsPending }),
}));
vi.mock('@client/app/hooks/data/teamPlanSettings', () => ({ useLowCreditsThreshold: () => 1000 }));
vi.mock('@client/app/hooks/useEffectiveCredits', () => ({ useEffectiveCredits: () => state.credits }));
vi.mock('./CreditsSection', () => ({ CreditsSection: () => <div data-testid="credits-section-body" /> }));
vi.mock('./PlansSection', () => ({
  PlansSection: () => <div data-testid="plans-section-body" />,
  PlansSectionSkeleton: () => <div data-testid="plans-section-skeleton" />,
}));

import BillingModal from './BillingModal';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const subRow = (overrides: Partial<IUserSubscription> = {}) =>
  ({
    subscriptionId: 'sub_1',
    priceId: 'price_unknown',
    status: 'active',
    canceledAt: null,
    periodEndsAt: new Date('2026-02-01T00:00:00Z'),
    ...overrides,
  }) as unknown as IUserSubscription;

const renderModal = (focus: BillingView = 'credits') =>
  render(
    <TestWrapper>
      <BillingModal open focus={focus} onClose={vi.fn()} />
    </TestWrapper>
  );

/** Section testids in document order. */
const sectionOrder = () =>
  Array.from(document.querySelectorAll('[data-testid^="billing-section-"]'))
    .map(el => el.getAttribute('data-testid'))
    .filter(id => id === 'billing-section-plans' || id === 'billing-section-credits');

describe('BillingModal', () => {
  beforeEach(() => {
    state.subscriptions = [];
    state.subscriptionsPending = false;
    state.credits = 5000;
  });

  it('leads with plans when the user has no subscription, and says they are on Free', () => {
    renderModal();
    expect(sectionOrder()).toEqual(['billing-section-plans', 'billing-section-credits']);
    expect(screen.getByTestId('billing-current-plan')).toHaveTextContent('Free');
    expect(screen.getByTestId('billing-balance')).toHaveTextContent('5,000');
  });

  it('leads with credit top-ups when the user has a plan in good standing', () => {
    state.subscriptions = [subRow()];
    renderModal();
    expect(sectionOrder()).toEqual(['billing-section-credits', 'billing-section-plans']);
    expect(screen.getByTestId('billing-current-plan')).toHaveTextContent('subscriptions.renews_on');
  });

  it('keeps plans first when the plan payment failed, so fixing it is the first thing shown', () => {
    state.subscriptions = [subRow({ status: 'past_due' })];
    renderModal();
    expect(sectionOrder()).toEqual(['billing-section-plans', 'billing-section-credits']);
    expect(screen.getByTestId('billing-current-plan')).toHaveTextContent('Payment failed');
  });

  it.each([
    ['plans', 'billing-section-plans-heading'],
    ['credits', 'billing-section-credits-heading'],
  ] as const)('moves focus to the %s heading for the deep-linked section', (focus, headingId) => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this);
    });
    renderModal(focus);
    expect(screen.getByTestId(headingId)).toHaveFocus();
    expect(scrolled.at(-1)).toBe(screen.getByTestId(`billing-section-${focus}`));
  });

  it('holds the frame with skeletons until the subscription state is known', () => {
    state.subscriptionsPending = true;
    renderModal('plans');
    expect(screen.getByTestId('plans-section-skeleton')).toBeInTheDocument();
    expect(sectionOrder()).toEqual([]);
  });

  it('nudges a low balance without a plan toward the plans section', () => {
    state.credits = 10;
    renderModal();
    expect(screen.getByTestId('billing-low-balance')).toHaveTextContent('credits_modal.low_credits');
    fireEvent.click(screen.getByTestId('billing-low-balance-action'));
    expect(screen.getByTestId('billing-section-plans-heading')).toHaveFocus();
  });

  it('nudges a low balance with a plan toward a top-up', () => {
    state.credits = 0;
    state.subscriptions = [subRow()];
    renderModal('plans');
    expect(screen.getByTestId('billing-low-balance')).toHaveTextContent('credits_modal.no_credits');
    fireEvent.click(screen.getByTestId('billing-low-balance-action'));
    expect(screen.getByTestId('billing-section-credits-heading')).toHaveFocus();
  });

  it('shows no low-balance banner when the balance is healthy', () => {
    renderModal();
    expect(screen.queryByTestId('billing-low-balance')).not.toBeInTheDocument();
  });
});
