import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { describe, expect, it, vi } from 'vitest';
import { BillingService, checkoutCallback, isStripeCheckoutUrl, type BillingContext } from './BillingService';

const plan = {
  priceId: 'price_pro',
  name: 'Professional',
  description: 'All models',
  credits: 50000,
  interval: 'monthly',
  priceCents: 3000,
  currency: 'usd',
  features: ['Credits roll over'],
};
const checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_123#details';

function build() {
  const get = vi.fn(async (path: string): Promise<unknown> =>
    path.includes('catalog=desktop') ? { billingEnabled: true, plans: [plan] } : []
  );
  const post = vi.fn().mockResolvedValue({ sessionUrl: checkoutUrl });
  const api = { get, post } as unknown as AuthenticatedApiClient;
  let context: BillingContext | null = { api, userId: 'user_1', environmentUrl: 'https://selected.example' };
  const openExternal = vi.fn().mockResolvedValue(undefined);
  const openCreditPayment = vi.fn().mockResolvedValue(undefined);
  const billing = new BillingService({ getContext: () => context, openExternal, openCreditPayment });
  return {
    billing,
    get,
    post,
    openExternal,
    openCreditPayment,
    setContext: (value: BillingContext | null) => {
      context = value;
    },
  };
}

describe('BillingService', () => {
  it('reads only public billing fields and non-terminal subscriptions, active first', async () => {
    const { billing, get } = build();
    get.mockImplementation(async path =>
      path.includes('catalog=desktop')
        ? { billingEnabled: true, plans: [plan], secret: 'discard' }
        : [
            { priceId: 'old', status: 'canceled' },
            { priceId: 'pending', status: 'past_due', canceledAt: '2026-11-01T00:00:00Z' },
            { priceId: 'active', status: 'active', subscriptionId: 'sub_1', userId: 'discard' },
            { priceId: 'expired', status: 'incomplete_expired' },
          ]
    );
    await expect(billing.billing()).resolves.toEqual({
      billingEnabled: true,
      plans: [plan],
      subscriptions: [
        { priceId: 'active', status: 'active', subscriptionId: 'sub_1', periodEndsAt: null, canceledAt: null },
        {
          priceId: 'pending',
          status: 'past_due',
          subscriptionId: null,
          periodEndsAt: null,
          canceledAt: '2026-11-01T00:00:00Z',
        },
      ],
    });
  });

  it('creates account-bound checkout with a fixed selected-environment callback and opens Stripe in main', async () => {
    const { billing, post, openExternal } = build();
    await expect(billing.subscribePlan('price_pro')).resolves.toEqual({ ok: true });
    expect(post).toHaveBeenCalledExactlyOnceWith('/api/subscriptions/subscribe', {
      priceId: 'price_pro',
      callbackUrl: 'https://selected.example/?billing=plans',
      attributionConsent: false,
    });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(checkoutUrl);
  });

  it.each(['active', 'past_due', 'trialing', 'unpaid', 'paused', 'incomplete', 'future_status'])(
    'blocks another checkout for a %s subscription, including grants without Stripe ids',
    async status => {
      const { billing, get, post } = build();
      get.mockImplementation(async path =>
        path.includes('catalog=desktop') ? { billingEnabled: true, plans: [plan] } : [{ priceId: 'other', status }]
      );
      await expect(billing.subscribePlan('price_pro')).resolves.toMatchObject({ ok: false });
      expect(post).not.toHaveBeenCalled();
    }
  );

  it('permits checkout after a terminal subscription', async () => {
    const { billing, get } = build();
    get.mockImplementation(async path =>
      path.includes('catalog=desktop')
        ? { billingEnabled: true, plans: [plan] }
        : [{ priceId: 'old', status: 'canceled' }]
    );
    await expect(billing.subscribePlan('price_pro')).resolves.toEqual({ ok: true });
  });

  it.each([
    { billingEnabled: false, plans: [plan] },
    { billingEnabled: true, plans: [] },
    { billingEnabled: true, plans: [{ ...plan, priceCents: null }] },
  ])('rejects unavailable catalog %j before checkout', async catalog => {
    const { billing, get, post } = build();
    get.mockImplementation(async path => (path.includes('catalog=desktop') ? catalog : []));
    await expect(billing.subscribePlan('price_pro')).resolves.toMatchObject({ ok: false });
    expect(post).not.toHaveBeenCalled();
  });

  it('does not trust renderer price ids or malformed IPC payloads', async () => {
    const { billing, post } = build();
    for (const value of ['price_unknown', '', {}, null]) {
      await expect(billing.subscribePlan(value)).resolves.toMatchObject({ ok: false });
    }
    expect(post).not.toHaveBeenCalled();
  });

  it('does not fetch while signed out', async () => {
    const { billing, get, setContext } = build();
    setContext(null);
    expect((await billing.billing()).error).toBeTruthy();
    await expect(billing.subscribePlan('price_pro')).resolves.toMatchObject({ ok: false });
    expect(get).not.toHaveBeenCalled();
  });

  it('fails closed for failed or malformed subscription reads', async () => {
    const { billing, get, post } = build();
    get.mockResolvedValue({ invalid: true });
    await expect(billing.billing()).resolves.toMatchObject({ billingEnabled: false, error: expect.any(String) });
    await expect(billing.subscribePlan('price_pro')).resolves.toMatchObject({ ok: false });
    get.mockRejectedValue(new Error('private server details'));
    expect((await billing.billing()).error).not.toContain('private server details');
    expect(post).not.toHaveBeenCalled();
  });

  it('does not open a session if the account or environment changes while checkout is created', async () => {
    const { billing, post, openExternal, setContext } = build();
    post.mockImplementation(async () => {
      setContext(null);
      return { sessionUrl: checkoutUrl };
    });
    await expect(billing.subscribePlan('price_pro')).resolves.toMatchObject({ ok: false });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('discards a billing read after an account switch', async () => {
    const { billing, get, setContext } = build();
    get.mockImplementation(async () => {
      setContext(null);
      return [];
    });
    await expect(billing.billing()).resolves.toMatchObject({ billingEnabled: false, error: expect.any(String) });
  });

  it('rejects overlapping checkout requests and allows retry after a failure', async () => {
    const { billing, post } = build();
    post.mockRejectedValue(new Error('offline'));
    const first = billing.subscribePlan('price_pro');
    await expect(billing.subscribePlan('price_pro')).resolves.toMatchObject({ ok: false });
    await first;
    post.mockResolvedValue({ sessionUrl: checkoutUrl });
    await expect(billing.subscribePlan('price_pro')).resolves.toEqual({ ok: true });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('never returns or opens arbitrary checkout URLs', async () => {
    const { billing, post, openExternal } = build();
    post.mockResolvedValue({ sessionUrl: 'https://attacker.example/path' });
    await expect(billing.subscribePlan('price_pro')).resolves.toMatchObject({ ok: false });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('reports browser-open failure without claiming checkout succeeded', async () => {
    const { billing, openExternal } = build();
    openExternal.mockRejectedValue(new Error('no browser'));
    await expect(billing.subscribePlan('price_pro')).resolves.toMatchObject({ ok: false });
  });
});

describe('credit checkout', () => {
  const pack = { id: 'package_25k', credits: 33333, price: 20, description: 'Starter' };
  function buildCredits() {
    const result = build();
    result.get.mockImplementation(async path =>
      path.includes('catalog=desktop') ? { billingEnabled: true, plans: [plan], creditPackages: [pack] } : []
    );
    result.post.mockResolvedValue({ clientSecret: 'pi_123_secret_abc', publishableKey: 'pk_test_123' });
    return result;
  }

  it('starts an account-bound pack intent and keeps payment credentials out of IPC', async () => {
    const { billing, post, openCreditPayment, openExternal } = buildCredits();
    await expect(billing.purchaseCredits(pack.id)).resolves.toEqual({ ok: true });
    expect(post).toHaveBeenCalledExactlyOnceWith('/api/stripe/start-payment', {
      transactionType: 'package',
      packageId: pack.id,
    });
    expect(openCreditPayment).toHaveBeenCalledWith(
      { clientSecret: 'pi_123_secret_abc', publishableKey: 'pk_test_123', credits: 33333, price: 20 },
      expect.any(Function)
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects unknown packs and signed-out purchases before creating an intent', async () => {
    const { billing, post, setContext } = buildCredits();
    for (const id of ['unknown', '', null, {}])
      await expect(billing.purchaseCredits(id)).resolves.toMatchObject({ ok: false });
    setContext(null);
    await expect(billing.purchaseCredits(pack.id)).resolves.toMatchObject({ ok: false });
    expect(post).not.toHaveBeenCalled();
  });

  it('discards an intent after account changes and rejects malformed payment credentials', async () => {
    const { billing, post, openCreditPayment, setContext } = buildCredits();
    post.mockResolvedValueOnce({ clientSecret: 'invalid', publishableKey: 'sk_test_private' });
    await expect(billing.purchaseCredits(pack.id)).resolves.toMatchObject({ ok: false });
    post.mockImplementation(async () => {
      setContext(null);
      return { clientSecret: 'pi_123_secret_abc', publishableKey: 'pk_test_123' };
    });
    await expect(billing.purchaseCredits(pack.id)).resolves.toMatchObject({ ok: false });
    expect(openCreditPayment).not.toHaveBeenCalled();
  });

  it('holds the checkout lock until the payment window closes', async () => {
    const { billing, openCreditPayment } = buildCredits();
    let close!: () => void;
    openCreditPayment.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          close = resolve;
        })
    );
    const purchase = billing.purchaseCredits(pack.id);
    await vi.waitFor(() => expect(openCreditPayment).toHaveBeenCalledTimes(1));
    await expect(billing.purchaseCredits(pack.id)).resolves.toMatchObject({ ok: false });
    await expect(billing.subscribePlan('price_pro')).resolves.toMatchObject({ ok: false });
    close();
    await expect(purchase).resolves.toEqual({ ok: true });
  });
});

describe('billing URL boundaries', () => {
  it.each([
    'https://checkout.stripe.com.evil.example/c/pay/cs_test_123',
    'https://checkout.stripe.com@evil.example/c/pay/cs_test_123',
    'https://user@checkout.stripe.com/c/pay/cs_test_123',
    'http://checkout.stripe.com/c/pay/cs_test_123',
    'https://checkout.stripe.com:444/c/pay/cs_test_123',
    'https://checkout.stripe.com/redirect',
    'file:///etc/passwd',
    'javascript:alert(1)',
  ])('rejects %s', url => expect(isStripeCheckoutUrl(url)).toBe(false));

  it('allows only Stripe checkout and fixed origin-only callback URLs', () => {
    expect(isStripeCheckoutUrl(checkoutUrl)).toBe(true);
    expect(checkoutCallback('https://chosen.example/path?redirect=evil#token')).toBe(
      'https://chosen.example/?billing=plans'
    );
    expect(checkoutCallback('http://localhost:3000')).toBe('http://localhost:3000/?billing=plans');
    expect(() => checkoutCallback('http://remote.example')).toThrow();
    expect(() => checkoutCallback('https://user:secret@chosen.example')).toThrow();
  });
});
