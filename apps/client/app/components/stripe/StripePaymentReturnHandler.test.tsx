import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const { mockGet, mockTrackPurchaseConversion, mockBootstrapSession, tokenState } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockTrackPurchaseConversion: vi.fn(),
  mockBootstrapSession: vi.fn(),
  tokenState: { accessToken: 'token' as string | null },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mockGet } }));
vi.mock('@client/app/utils/purchaseConversion', () => ({ trackPurchaseConversion: mockTrackPurchaseConversion }));
vi.mock('@client/app/utils/sessionBootstrap', () => ({ bootstrapSession: mockBootstrapSession }));
vi.mock('@client/app/hooks/useAccessToken', () => ({ useAccessToken: { getState: () => tokenState } }));

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

import { consumeBillingCheckoutReturn } from '@client/app/utils/billingCheckoutReturn';
import StripePaymentReturnHandler, { reportCreditPurchaseConversion } from './StripePaymentReturnHandler';

const FACTS = {
  transactionId: 'pi_test_1',
  value: 20,
  currency: 'USD',
  priceId: 'credits-starter',
  planName: 'Credits package (10,000)',
  quantity: 1,
  kind: 'credits',
};

function returnTo(search: string, hash = '') {
  window.history.replaceState({}, '', `/settings/credits${search}${hash}`);
  return render(<StripePaymentReturnHandler />);
}

const STRIPE_RETURN =
  '?payment_intent=pi_test_1&payment_intent_client_secret=pi_test_1_secret_abc&redirect_status=succeeded';

describe('StripePaymentReturnHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mockGet.mockResolvedValue({ data: FACTS });
    mockBootstrapSession.mockResolvedValue(undefined);
    tokenState.accessToken = 'token';
  });

  it('reports a succeeded credit purchase with the facts the server read from Stripe', async () => {
    returnTo(STRIPE_RETURN);

    await waitFor(() => expect(mockTrackPurchaseConversion).toHaveBeenCalledExactlyOnceWith(FACTS));
    expect(mockGet).toHaveBeenCalledExactlyOnceWith('/api/stripe/payment-intent', { params: { id: 'pi_test_1' } });
  });

  it('waits for the cold-load session bootstrap before the lookup', async () => {
    let finishBootstrap!: () => void;
    mockBootstrapSession.mockReturnValue(new Promise<void>(resolve => (finishBootstrap = resolve)));
    returnTo(STRIPE_RETURN);

    await settle();
    expect(mockGet).not.toHaveBeenCalled();

    finishBootstrap();
    await waitFor(() => expect(mockGet).toHaveBeenCalledOnce());
  });

  it('skips the lookup and releases the claim when no session was restored', async () => {
    tokenState.accessToken = null;
    returnTo(STRIPE_RETURN);

    await waitFor(() => expect(window.sessionStorage.getItem('b4m-reported-checkout-sessions')).toBe('[]'));
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("strips Stripe's params, the client secret included, and keeps the rest of the URL", () => {
    returnTo(`${STRIPE_RETURN}&tab=billing`, '#top');

    expect(window.location.pathname).toBe('/settings/credits');
    expect(window.location.search).toBe('?tab=billing');
    expect(window.location.hash).toBe('#top');
  });

  it('reports an in-page success once, even if the same payment also comes back through a redirect', async () => {
    reportCreditPurchaseConversion('pi_test_1');
    returnTo(STRIPE_RETURN);

    await waitFor(() => expect(mockTrackPurchaseConversion).toHaveBeenCalledOnce());
    expect(mockGet).toHaveBeenCalledOnce();
  });

  it.each([
    ['succeeded', '&billing=credits', true],
    ['processing', '&billing=credits', true],
    ['failed', '&billing=credits', false],
    ['succeeded', '', false],
  ])('marks a billing checkout return for redirect_status=%s with %s: %s', (status, extra, marked) => {
    consumeBillingCheckoutReturn();
    returnTo(`?payment_intent=pi_test_1&payment_intent_client_secret=s&redirect_status=${status}${extra}`);

    expect(consumeBillingCheckoutReturn()).toBe(marked);
  });

  it('reports a payment once, even if the return URL is loaded again', async () => {
    returnTo(STRIPE_RETURN).unmount();
    returnTo(STRIPE_RETURN);

    await waitFor(() => expect(mockTrackPurchaseConversion).toHaveBeenCalledOnce());
    expect(mockGet).toHaveBeenCalledOnce();
  });

  it('does not look up a payment that did not succeed, but still cleans the URL', () => {
    for (const status of ['processing', 'failed', '']) {
      returnTo(`?payment_intent=pi_test_2&payment_intent_client_secret=s&redirect_status=${status}`);
      expect(window.location.search, status).toBe('');
    }
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('ignores an id that is not a payment intent', () => {
    returnTo('?payment_intent=cs_test_1&redirect_status=succeeded');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('does nothing at all on an ordinary page load', () => {
    returnTo('?tab=billing');
    expect(mockGet).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?tab=billing');
  });

  it('swallows a failed lookup: analytics never surfaces to the customer', async () => {
    mockGet.mockRejectedValue(new Error('400'));
    returnTo(STRIPE_RETURN);

    await waitFor(() => expect(mockGet).toHaveBeenCalledOnce());
    expect(mockTrackPurchaseConversion).not.toHaveBeenCalled();
  });

  it('releases the claim when the lookup fails, so a reload reports the payment once', async () => {
    mockGet.mockRejectedValueOnce(new Error('503'));
    returnTo(STRIPE_RETURN).unmount();
    await waitFor(() => expect(mockGet).toHaveBeenCalledOnce());
    await waitFor(() => expect(window.sessionStorage.getItem('b4m-reported-checkout-sessions')).toBe('[]'));
    expect(mockTrackPurchaseConversion).not.toHaveBeenCalled();

    returnTo(STRIPE_RETURN).unmount();
    await waitFor(() => expect(mockTrackPurchaseConversion).toHaveBeenCalledExactlyOnceWith(FACTS));

    returnTo(STRIPE_RETURN);
    await settle();
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockTrackPurchaseConversion).toHaveBeenCalledOnce();
  });

  it('lets the in-page path retry after a failed lookup too', async () => {
    mockGet.mockRejectedValueOnce(new Error('503'));
    reportCreditPurchaseConversion('pi_test_1');
    await waitFor(() => expect(window.sessionStorage.getItem('b4m-reported-checkout-sessions')).toBe('[]'));

    reportCreditPurchaseConversion('pi_test_1');
    await waitFor(() => expect(mockTrackPurchaseConversion).toHaveBeenCalledExactlyOnceWith(FACTS));
  });
});
