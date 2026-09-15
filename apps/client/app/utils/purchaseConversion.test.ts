import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockTrackRedditEvent } = vi.hoisted(() => ({
  mockTrackRedditEvent: vi.fn(),
}));

vi.mock('./redditPixel', () => ({
  trackRedditEvent: mockTrackRedditEvent,
}));

import { trackPurchaseConversion } from './purchaseConversion';

function setCookie(name: string, value: object) {
  document.cookie = `${name}=${encodeURIComponent(JSON.stringify(value))}; path=/`;
}

function clearCookie(name: string) {
  document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

const PURCHASE = {
  transactionId: 'cs_test_1',
  value: 30,
  currency: 'USD',
  priceId: 'price_pro',
  planName: 'Professional',
};

describe('trackPurchaseConversion', () => {
  const mockGtag = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('gtag', mockGtag);
    clearCookie('b4m-first-touch');
    clearCookie('b4m_utm');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fires GA4 purchase with the transaction id, value, currency and item', () => {
    trackPurchaseConversion(PURCHASE);

    expect(mockGtag).toHaveBeenCalledWith('event', 'purchase', {
      transaction_id: 'cs_test_1',
      value: 30,
      currency: 'USD',
      items: [{ item_id: 'price_pro', item_name: 'Professional', price: 30, quantity: 1 }],
    });
  });

  it('sends value, currency and the dedupe id to Reddit', () => {
    trackPurchaseConversion(PURCHASE);

    expect(mockTrackRedditEvent).toHaveBeenCalledExactlyOnceWith('Purchase', {
      value: 30,
      currency: 'USD',
      transactionId: 'cs_test_1',
    });
  });

  it('stamps first-touch and session-UTM attribution from the shared cookies', () => {
    setCookie('b4m-first-touch', { source: 'reddit', medium: 'cpc', campaign: 'launch-v1' });
    setCookie('b4m_utm', { source: 'newsletter', medium: 'email' });

    trackPurchaseConversion(PURCHASE);

    expect(mockGtag).toHaveBeenCalledWith(
      'event',
      'purchase',
      expect.objectContaining({
        first_touch_source: 'reddit',
        first_touch_medium: 'cpc',
        first_touch_campaign: 'launch-v1',
        utm_source_at_purchase: 'newsletter',
        utm_medium_at_purchase: 'email',
      })
    );
  });

  it('derives per-unit price from a multi-seat purchase', () => {
    trackPurchaseConversion({ ...PURCHASE, value: 150, quantity: 5 });

    expect(mockGtag).toHaveBeenCalledWith(
      'event',
      'purchase',
      expect.objectContaining({
        value: 150,
        items: [{ item_id: 'price_pro', item_name: 'Professional', price: 30, quantity: 5 }],
      })
    );
  });

  it('omits items entirely when the plan is unknown', () => {
    trackPurchaseConversion({ transactionId: 'cs_test_2', value: 30, currency: 'USD' });

    const params = mockGtag.mock.calls[0][2] as Record<string, unknown>;
    expect(params).not.toHaveProperty('items');
    expect(params.transaction_id).toBe('cs_test_2');
  });

  it('still reports to Reddit when GA4 is absent', () => {
    vi.stubGlobal('gtag', undefined);

    trackPurchaseConversion(PURCHASE);

    expect(mockGtag).not.toHaveBeenCalled();
    expect(mockTrackRedditEvent).toHaveBeenCalledOnce();
  });
});
