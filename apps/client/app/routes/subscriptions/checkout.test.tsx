import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import SubscriptionsCheckoutPage, { resolveCheckoutPlan } from './checkout';

const mocks = vi.hoisted(() => ({
  plan: undefined as string | undefined,
  returnTo: undefined as string | undefined,
  currentUser: { id: 'u1' } as { id: string } | null,
  enforceCredits: true as boolean,
  settingsPending: false,
  navigate: vi.fn(),
  historyPush: vi.fn(),
  subscribe: {
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null as unknown,
  },
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ history: { push: mocks.historyPush } }),
  useSearch: () => ({ plan: mocks.plan, return_to: mocks.returnTo }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: mocks.currentUser }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useSettingsFromServer: () => ({ isPending: mocks.settingsPending }),
  useGetSettingsValue: () => mocks.enforceCredits,
}));
vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useSubscribePlan: () => mocks.subscribe,
}));
vi.mock('@bike4mind/server-utils/lib/userSubscriptions/constants', () => ({
  SUBSCRIPTION_PLANS_MAP: { price_known: { priceId: 'price_known' } },
  PROFESSIONAL_PRICE_ID: 'price_known',
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderPage = () =>
  render(
    <TestWrapper>
      <SubscriptionsCheckoutPage />
    </TestWrapper>
  );

describe('SubscriptionsCheckoutPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.plan = 'price_known';
    mocks.returnTo = undefined;
    mocks.currentUser = { id: 'u1' };
    mocks.enforceCredits = true;
    mocks.settingsPending = false;
    Object.assign(mocks.subscribe, { isPending: false, isSuccess: false, isError: false, error: null });
  });

  it('starts checkout for a configured plan and shows no error', () => {
    renderPage();

    expect(mocks.subscribe.mutate).toHaveBeenCalledWith(
      { priceId: 'price_known', callbackUrl: window.location.origin },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
    expect(screen.queryByTestId('checkout-error-card')).not.toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('waits for settings before deciding anything', () => {
    mocks.settingsPending = true;
    renderPage();

    expect(mocks.subscribe.mutate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('checkout-error-card')).not.toBeInTheDocument();
  });

  it.each([
    ['missing', undefined],
    ['unknown', 'price_unknown'],
  ])('explains a %s plan instead of silently redirecting', (_label, plan) => {
    mocks.plan = plan;
    renderPage();

    expect(screen.getByText('We could not find that plan')).toBeInTheDocument();
    expect(mocks.subscribe.mutate).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('checkout-error-plans-btn'));
    expect(mocks.historyPush).toHaveBeenCalledWith('/new?billing=plans');
  });

  it('explains that subscriptions are unavailable when credits are not enforced', () => {
    mocks.enforceCredits = false;
    renderPage();

    expect(screen.getByText('Subscriptions are not available here')).toBeInTheDocument();
    expect(screen.queryByTestId('checkout-error-plans-btn')).not.toBeInTheDocument();
    expect(mocks.subscribe.mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('checkout-error-home-btn'));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/' });
  });

  it('shows the failure and the server reason when checkout is refused', () => {
    Object.assign(mocks.subscribe, { isError: true, error: new Error('Unknown plan') });
    renderPage();

    expect(screen.getByText('We could not start your checkout')).toBeInTheDocument();
    expect(screen.getByTestId('checkout-error-detail')).toHaveTextContent('Unknown plan');
    expect(screen.getByTestId('checkout-error-support-btn')).toHaveAttribute('href');
    expect(mocks.subscribe.mutate).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('still sends a signed-out visitor to register with the plan preserved', () => {
    mocks.currentUser = null;
    renderPage();

    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/register?redirectTo=/subscriptions/checkout?plan=price_known',
    });
    expect(mocks.subscribe.mutate).not.toHaveBeenCalled();
  });

  it('takes the professional alias for the Professional price', () => {
    mocks.plan = 'professional';
    renderPage();

    expect(mocks.subscribe.mutate).toHaveBeenCalledWith(
      { priceId: 'price_known', callbackUrl: window.location.origin },
      expect.anything()
    );
  });

  it('carries an allowed return target through Stripe on this origin', () => {
    mocks.plan = 'professional';
    mocks.returnTo = 'https://paintbox.bike4mind.com/';
    renderPage();

    const callbackUrl = new URL(mocks.subscribe.mutate.mock.calls[0]![0].callbackUrl);
    expect(callbackUrl.origin).toBe(window.location.origin);
    expect(callbackUrl.searchParams.get('checkout_return_to')).toBe('https://paintbox.bike4mind.com/');
  });

  it('ignores a return target it does not allow', () => {
    mocks.returnTo = 'https://evil.example/';
    renderPage();

    expect(mocks.subscribe.mutate).toHaveBeenCalledWith(
      { priceId: 'price_known', callbackUrl: window.location.origin },
      expect.anything()
    );
  });

  it('keeps the return target through sign-up', () => {
    mocks.currentUser = null;
    mocks.plan = 'professional';
    mocks.returnTo = 'https://paintbox.bike4mind.com/';
    renderPage();

    const to = (mocks.navigate.mock.calls[0]![0] as { to: string }).to;
    const resume = new URL(new URLSearchParams(to.split('?')[1]).get('redirectTo')!, 'https://app.example');
    expect(resume.pathname).toBe('/subscriptions/checkout');
    expect(resume.searchParams.get('plan')).toBe('professional');
    expect(resume.searchParams.get('return_to')).toBe('https://paintbox.bike4mind.com/');
  });

  it('resolves a plan name, passes a price id through, and ignores prototype keys', () => {
    expect(resolveCheckoutPlan('professional')).toBe('price_known');
    expect(resolveCheckoutPlan('price_other')).toBe('price_other');
    expect(resolveCheckoutPlan(undefined)).toBeUndefined();
    expect(resolveCheckoutPlan('constructor')).toBe('constructor');
  });
});
