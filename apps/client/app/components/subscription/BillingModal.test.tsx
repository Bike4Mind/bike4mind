import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IUserSubscription } from '@client/lib/userSubscriptions/types';
import { SubscriptionSource } from '@bike4mind/server-utils/lib/subscriptions/types';
import type { BillingView } from '@client/app/utils/billingDeepLink';

const state = vi.hoisted(() => ({
  subscriptions: [] as unknown[],
  subscriptionsPending: false,
  subscriptionsError: false,
  plansLoading: false,
  plansDisabled: false,
  reducedMotion: false,
  refetch: vi.fn(),
  credits: 5000,
  account: undefined as { personal: boolean } | undefined,
}));
const logEvent = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));
vi.mock('@client/app/hooks/data/credits', () => ({ useGetCreditTransactions: () => ({ data: [], isPending: false }) }));
vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useGetSubscriptions: () => ({
    data: state.subscriptionsError ? undefined : state.subscriptions,
    isPending: state.subscriptionsPending,
    isError: state.subscriptionsError,
    isFetching: false,
    refetch: state.refetch,
  }),
}));
vi.mock('@client/app/hooks/data/stripe', () => ({
  useGetSubscriptionPlans: () =>
    state.plansDisabled
      ? { isLoading: false, isPending: true, fetchStatus: 'idle' }
      : { isLoading: state.plansLoading, isPending: state.plansLoading, fetchStatus: 'fetching' },
}));
vi.mock('@client/app/hooks/data/teamPlanSettings', () => ({ useLowCreditsThreshold: () => 1000 }));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: () => ({ selectedAccount: state.account }),
}));
vi.mock('@client/app/hooks/useEffectiveCredits', () => ({ useEffectiveCredits: () => state.credits }));
vi.mock('@client/app/hooks/data/analytics', () => ({ useLogEvent: () => ({ mutate: logEvent }) }));
vi.mock('./NoCardUnlockCard', () => ({ NoCardUnlockCard: () => <div data-testid="no-card-unlock-card" /> }));
vi.mock('./CreditsExplanation', () => ({
  default: () => <div data-testid="credits-explanation" />,
}));
vi.mock('./CreditsSection', () => ({
  CreditsSection: ({
    onClose,
    onPurchase,
    onPaymentPending,
  }: {
    onClose: () => void;
    onPurchase?: () => void;
    onPaymentPending?: () => void;
  }) => (
    <div data-testid="credits-section-body">
      <button type="button" data-testid="credits-section-see-usage" onClick={onClose} />
      <button type="button" data-testid="credits-purchase-success" onClick={onPurchase} />
      <button type="button" data-testid="credits-payment-pending" onClick={onPaymentPending} />
      <button type="button" data-testid="credits-payment-failed" />
    </div>
  ),
}));
vi.mock('./PlansSection', () => ({
  PlansSection: ({ onSubscriptionChanged }: { onSubscriptionChanged?: () => void }) => (
    <div data-testid="plans-section-body">
      <button type="button" data-testid="subscription-changed" onClick={onSubscriptionChanged} />
      <button type="button" data-testid="subscription-canceled" />
    </div>
  ),
  PlansSectionSkeleton: () => <div data-testid="plans-section-skeleton" />,
}));

import BillingModal from './BillingModal';
import { consumeBillingCheckoutReturn, markBillingCheckoutReturn } from '@client/app/utils/billingCheckoutReturn';

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

const renderModal = (focus?: BillingView) =>
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
    state.subscriptionsError = false;
    state.plansLoading = false;
    state.plansDisabled = false;
    state.reducedMotion = false;
    state.refetch.mockClear();
    window.matchMedia = vi.fn((query: string) => ({
      matches: query.includes('reduce') && state.reducedMotion,
      media: query,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    state.credits = 5000;
    state.account = undefined;
    logEvent.mockClear();
  });

  it('logs the open context and a close without purchase', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <TestWrapper>
        <BillingModal open focus="credits" entry="credits_chip" onClose={onClose} />
      </TestWrapper>
    );
    expect(logEvent).toHaveBeenCalledWith({
      type: 'billing_opened',
      metadata: { entry: 'credits_chip', focus: 'credits', account: 'personal' },
    });
    fireEvent.click(screen.getByTestId('billing-modal-close'));
    expect(onClose).toHaveBeenCalled();
    rerender(
      <TestWrapper>
        <BillingModal open={false} entry="credits_chip" onClose={onClose} />
      </TestWrapper>
    );
    expect(logEvent).toHaveBeenCalledWith({
      type: 'billing_closed_without_purchase',
      metadata: { entry: 'credits_chip', focus: 'credits', account: 'personal' },
    });
  });

  it('tags the open and close with an org account, which cannot buy personal packs', () => {
    state.account = { personal: false };
    const content = (open: boolean) => (
      <TestWrapper>
        <BillingModal open={open} entry="credits_chip" onClose={vi.fn()} />
      </TestWrapper>
    );
    const { rerender } = render(content(true));
    rerender(content(false));
    expect(logEvent).toHaveBeenCalledWith({
      type: 'billing_opened',
      metadata: { entry: 'credits_chip', focus: 'overview', account: 'org' },
    });
    expect(logEvent).toHaveBeenCalledWith({
      type: 'billing_closed_without_purchase',
      metadata: { entry: 'credits_chip', focus: 'overview', account: 'org' },
    });
  });

  it('logs nothing for the open and close that follow a Stripe return, then logs the next cycle', () => {
    markBillingCheckoutReturn();
    const content = (open: boolean) => (
      <TestWrapper>
        <BillingModal open={open} onClose={vi.fn()} />
      </TestWrapper>
    );
    const { rerender } = render(content(true));
    rerender(content(false));
    expect(logEvent).not.toHaveBeenCalled();

    rerender(content(true));
    rerender(content(false));
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'billing_opened' }));
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'billing_closed_without_purchase' }));
    expect(consumeBillingCheckoutReturn()).toBe(false);
  });

  it.each([
    ['credits-purchase-success', false],
    ['credits-payment-pending', false],
    ['subscription-changed', false],
    ['credits-payment-failed', true],
    ['subscription-canceled', true],
  ])('records abandonment correctly after %s', (testId, abandoned) => {
    const content = (open: boolean) => (
      <TestWrapper>
        <BillingModal open={open} onClose={vi.fn()} />
      </TestWrapper>
    );
    const { rerender } = render(content(true));
    fireEvent.click(screen.getByTestId(testId));
    rerender(content(false));
    const abandonment = expect.objectContaining({ type: 'billing_closed_without_purchase' });
    if (abandoned) expect(logEvent).toHaveBeenCalledWith(abandonment);
    else expect(logEvent).not.toHaveBeenCalledWith(abandonment);
  });

  it('does not count leaving for the usage page as a close without purchase', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <TestWrapper>
        <BillingModal open focus="credits" entry="credits_chip" onClose={onClose} />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('credits-section-see-usage'));
    expect(onClose).toHaveBeenCalled();
    rerender(
      <TestWrapper>
        <BillingModal open={false} entry="credits_chip" onClose={onClose} />
      </TestWrapper>
    );
    expect(logEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'billing_closed_without_purchase' }));
  });

  it('says the plan is unavailable, not Free, when the subscriptions read fails, and retries on demand', () => {
    state.subscriptionsError = true;
    renderModal();
    const plan = screen.getByTestId('billing-current-plan');
    expect(plan).toHaveTextContent('Unavailable');
    expect(plan).not.toHaveTextContent('Free');
    // Neutral order and copy: nothing reads the failure as "no plan".
    expect(sectionOrder()).toEqual(['billing-section-credits', 'billing-section-plans']);
    expect(screen.getByTestId('billing-section-plans-heading')).toHaveTextContent('Plans');
    fireEvent.click(screen.getByTestId('billing-current-plan-retry'));
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });

  it('leads with plans when the user has no subscription, and says they are on Free', () => {
    renderModal();
    expect(sectionOrder()).toEqual(['billing-section-plans', 'billing-section-credits']);
    expect(screen.getByTestId('credits-explanation')).toBeInTheDocument();
    expect(screen.getByTestId('billing-current-plan')).toHaveTextContent('Free');
    expect(screen.getByTestId('billing-balance')).toHaveTextContent('5,000');
    const icon = screen.getByTestId('billing-balance-icon');
    expect(screen.getByTestId('billing-balance')).toContainElement(icon);
    expect(icon).toHaveAttribute('aria-hidden', 'true');
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

  it('shows the dunned Stripe row, not an active admin grant at the same price, like the plan card does', () => {
    state.subscriptions = [
      subRow({ subscriptionId: 'admin_granted_1', source: SubscriptionSource.AdminGrant, status: 'active' }),
      subRow({ subscriptionId: 'sub_stripe', source: SubscriptionSource.Stripe, status: 'past_due' }),
    ];
    renderModal();
    expect(screen.getByTestId('billing-current-plan')).toHaveTextContent('Payment failed');
    expect(sectionOrder()).toEqual(['billing-section-plans', 'billing-section-credits']);
  });

  it('prefers the active row over a trialing one listed before it', () => {
    state.subscriptions = [
      subRow({ subscriptionId: 'sub_trial', status: 'trialing', canceledAt: new Date('2026-01-01T00:00:00Z') }),
      subRow({ subscriptionId: 'sub_active', status: 'active' }),
    ];
    renderModal();
    expect(screen.getByTestId('billing-current-plan')).toHaveTextContent('subscriptions.renews_on');
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

  it('leaves focus on the dialog and does not scroll when no section was asked for', () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    renderModal();
    expect(scrollSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('billing-section-plans-heading')).not.toHaveFocus();
    expect(screen.getByTestId('billing-section-credits-heading')).not.toHaveFocus();
  });

  it('holds the sections until the plan prices load, so a deep-link scroll lands on a settled layout', () => {
    state.plansLoading = true;
    renderModal('credits');
    expect(screen.getByTestId('plans-section-skeleton')).toBeInTheDocument();
    expect(sectionOrder()).toEqual([]);
  });

  it.each([
    [false, 'smooth'],
    [true, 'auto'],
  ] as const)('scrolls the banner action with reduced motion %s as %s', (reduced, behavior) => {
    state.reducedMotion = reduced;
    state.credits = 10;
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    renderModal();
    fireEvent.click(screen.getByTestId('billing-low-balance-action'));
    expect(scrollSpy).toHaveBeenCalledWith({ behavior, block: 'start' });
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

  it('offers no dead-end Top up for a low organization balance', () => {
    state.credits = 0;
    state.account = { personal: false };
    state.subscriptions = [subRow()];
    renderModal();
    expect(screen.getByTestId('billing-low-balance')).toHaveTextContent('An organization admin can add credits');
    expect(screen.queryByTestId('billing-low-balance-action')).not.toBeInTheDocument();
  });

  it('shows no low-balance banner when the balance is healthy', () => {
    renderModal();
    expect(screen.queryByTestId('billing-low-balance')).not.toBeInTheDocument();
  });

  it('shows only the credit packs, with no stuck plans skeleton, when plans are not offered (enforceCredits off)', () => {
    state.plansDisabled = true;
    state.credits = 0;
    renderModal();
    expect(sectionOrder()).toEqual(['billing-section-credits']);
    expect(screen.queryByTestId('plans-section-skeleton')).not.toBeInTheDocument();
    expect(screen.getByTestId('billing-low-balance-action')).toHaveTextContent('Top up');
  });
});
