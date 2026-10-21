import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockMeta, mockAttribution } = vi.hoisted(() => ({ mockMeta: vi.fn(), mockAttribution: vi.fn() }));
vi.mock('./metaPixel', () => ({ trackMetaEvent: mockMeta }));
vi.mock('./attributionCookies', () => ({ attributionParams: mockAttribution }));

import {
  checkoutSurfaceParam,
  resetUpsellImpressionsForTest,
  setFunnelSyntheticUser,
  trackBeginCheckout,
  trackUpsell,
} from './funnelEvents';

const gtag = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('gtag', gtag);
  mockAttribution.mockReturnValue({ first_touch_source: 'reddit' });
  setFunnelSyntheticUser(false);
  resetUpsellImpressionsForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('trackUpsell', () => {
  it('sends upsell_<action> with the surface, trigger and plan', () => {
    expect(trackUpsell('click', { surface: 'credits_modal', trigger: 'low_balance', plan: 'Professional' })).toBe(true);
    expect(gtag).toHaveBeenCalledWith('event', 'upsell_click', {
      surface: 'credits_modal',
      trigger: 'low_balance',
      plan: 'Professional',
    });
  });

  it('reports an impression once per surface per page load', () => {
    expect(trackUpsell('impression', { surface: 'out_of_credits_notice' })).toBe(true);
    expect(trackUpsell('impression', { surface: 'out_of_credits_notice' })).toBe(false);
    expect(trackUpsell('impression', { surface: 'session_warning_banner' })).toBe(true);
    expect(gtag).toHaveBeenCalledTimes(2);
  });

  it('does not dedupe clicks or dismissals', () => {
    trackUpsell('dismiss', { surface: 'credits_modal' });
    trackUpsell('dismiss', { surface: 'credits_modal' });
    expect(gtag).toHaveBeenCalledTimes(2);
  });

  it('sends nothing for a synthetic user', () => {
    setFunnelSyntheticUser(true);
    expect(trackUpsell('click', { surface: 'credits_modal' })).toBe(false);
    expect(gtag).not.toHaveBeenCalled();
  });

  it('is a no-op when gtag is not loaded', () => {
    vi.stubGlobal('gtag', undefined);
    expect(trackUpsell('click', { surface: 'credits_modal' })).toBe(false);
  });
});

describe('trackBeginCheckout', () => {
  it('sends GA4 begin_checkout with plan, owner, surface and attribution, plus Meta InitiateCheckout', () => {
    expect(
      trackBeginCheckout({
        plan: 'team',
        priceId: 'price_team',
        ownerType: 'organization',
        surface: 'team_invite',
        quantity: 5,
      })
    ).toBe(true);
    expect(gtag).toHaveBeenCalledWith('event', 'begin_checkout', {
      plan: 'team',
      owner_type: 'organization',
      surface: 'team_invite',
      items: [{ item_id: 'price_team', item_name: 'team', quantity: 5 }],
      first_touch_source: 'reddit',
    });
    expect(mockAttribution).toHaveBeenCalledWith('checkout');
    expect(mockMeta).toHaveBeenCalledWith('InitiateCheckout');
  });

  it('defaults the surface to unknown', () => {
    trackBeginCheckout({ plan: 'Professional', priceId: 'price_pro', ownerType: 'user' });
    expect(gtag.mock.calls[0][2]).toMatchObject({ surface: 'unknown' });
  });

  it('sends nothing anywhere for a synthetic user', () => {
    setFunnelSyntheticUser(true);
    expect(trackBeginCheckout({ plan: 'Professional', priceId: 'price_pro', ownerType: 'user' })).toBe(false);
    expect(gtag).not.toHaveBeenCalled();
    expect(mockMeta).not.toHaveBeenCalled();
  });
});

describe('checkoutSurfaceParam', () => {
  it('passes a well-formed id and drops one checkout would reject', () => {
    expect(checkoutSurfaceParam('credits_modal')).toBe('credits_modal');
    expect(checkoutSurfaceParam('Credits Modal')).toBeUndefined();
    expect(checkoutSurfaceParam('x'.repeat(41))).toBeUndefined();
    expect(checkoutSurfaceParam(undefined)).toBeUndefined();
  });
});
