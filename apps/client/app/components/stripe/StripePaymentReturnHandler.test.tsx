import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const { mockGet, mockTrackPurchaseConversion } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockTrackPurchaseConversion: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mockGet } }));
vi.mock('@client/app/utils/purchaseConversion', () => ({ trackPurchaseConversion: mockTrackPurchaseConversion }));

import StripePaymentReturnHandler from './StripePaymentReturnHandler';

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
  });

  it('reports a succeeded credit purchase with the facts the server read from Stripe', async () => {
    returnTo(STRIPE_RETURN);

    expect(mockGet).toHaveBeenCalledExactlyOnceWith('/api/stripe/payment-intent', { params: { id: 'pi_test_1' } });
    await waitFor(() => expect(mockTrackPurchaseConversion).toHaveBeenCalledExactlyOnceWith(FACTS));
  });

  it("strips Stripe's params, the client secret included, and keeps the rest of the URL", () => {
    returnTo(`${STRIPE_RETURN}&tab=billing`, '#top');

    expect(window.location.pathname).toBe('/settings/credits');
    expect(window.location.search).toBe('?tab=billing');
    expect(window.location.hash).toBe('#top');
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
});
