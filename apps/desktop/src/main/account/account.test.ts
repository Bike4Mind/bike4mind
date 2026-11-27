import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { openCreditPayment, paymentHtml } from './CreditPaymentWindow';
import { AccountService, readBalance, readExpiring, readMonthlyAllowance, readPlan, readTier } from './AccountService';
import { BillingService, checkoutCallback, isStripeCheckoutUrl, type BillingContext } from './BillingService';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';

const mocks = vi.hoisted(() => ({
  created: vi.fn(),
  clearStorageData: vi.fn().mockResolvedValue(undefined),
  setPermissionRequestHandler: vi.fn(),
}));
vi.mock('electron', () => ({
  session: {
    fromPartition: () => ({
      clearStorageData: mocks.clearStorageData,
      setPermissionRequestHandler: mocks.setPermissionRequestHandler,
    }),
  },
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
    url = '';
    destroyed = false;
    constructor(options: unknown) {
      super();
      mocks.created(this, options);
    }
    async loadURL(url: string) {
      this.url = url;
    }
    isDestroyed() {
      return this.destroyed;
    }
    close() {
      this.destroyed = true;
      this.emit('closed');
    }
    destroy() {
      this.close();
    }
  },
}));

const payment = { clientSecret: 'pi_123_secret_abc', publishableKey: 'pk_test_123', credits: 33333, price: 20 };

afterEach(() => vi.clearAllMocks());

describe('isolated credit payment window', () => {
  it('serves a protected Stripe page without a desktop preload and tears it down on close', async () => {
    const checkout = openCreditPayment(payment, () => true);
    await vi.waitFor(() => expect(mocks.created).toHaveBeenCalledOnce());
    const [window, options] = mocks.created.mock.calls[0];
    await vi.waitFor(() => expect(window.url).not.toBe(''));
    try {
      expect(options.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true });
      expect(options.webPreferences.preload).toBeUndefined();
      const response = await fetch(window.url);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      const html = await response.text();
      expect(html).toContain('https://js.stripe.com/v3/');
      expect(html).toContain('stripe.confirmPayment');
      expect((await fetch(new URL('/', window.url))).status).toBe(404);
      expect((await fetch(window.url, { method: 'POST' })).status).toBe(404);
      expect((await fetch(`${window.url}/return?payment_intent=pi_123`)).status).toBe(200);
      const local = new URL(window.url);
      const malformedStatus = await new Promise<number | undefined>((resolve, reject) => {
        const req = request({ hostname: local.hostname, port: local.port, path: 'http://[' }, res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.setTimeout(1000, () => req.destroy(new Error('Malformed request was not answered')));
        req.end();
      });
      expect(malformedStatus).toBe(404);
      const preventDefault = vi.fn();
      window.webContents.emit('will-navigate', { preventDefault }, 'file:///etc/passwd');
      expect(preventDefault).toHaveBeenCalledOnce();
      for (const event of ['will-navigate', 'will-redirect']) {
        for (const target of [
          'https://example.com',
          'https://checkout.stripe.com.evil.example',
          'not a url',
          'https://user@hooks.stripe.com',
          'https://hooks.stripe.com:444',
        ]) {
          const deny = vi.fn();
          window.webContents.emit(event, { preventDefault: deny }, target);
          expect(deny, target).toHaveBeenCalledOnce();
        }
        for (const target of [
          window.url,
          `${window.url}/return`,
          'https://hooks.stripe.com/3d_secure',
          'https://checkout.stripe.com/pay',
          'https://js.stripe.com/v3',
        ]) {
          const deny = vi.fn();
          window.webContents.emit(event, { preventDefault: deny }, target);
          expect(deny, target).not.toHaveBeenCalled();
        }
      }
      const popupHandler = window.webContents.setWindowOpenHandler.mock.calls[0][0];
      expect(popupHandler()).toEqual({ action: 'deny' });
    } finally {
      window.close();
      await checkout;
    }
    expect(mocks.clearStorageData).toHaveBeenCalledOnce();
    await expect(fetch(window.url)).rejects.toThrow();
  });

  it('refuses to open for a changed account', async () => {
    await expect(openCreditPayment(payment, () => false)).rejects.toThrow('Account changed');
    expect(mocks.created).not.toHaveBeenCalled();
  });

  it('closes an open payment window after the account changes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let current = true;
    const checkout = openCreditPayment(payment, () => current);
    await vi.waitFor(() => expect(mocks.created).toHaveBeenCalledOnce());
    const [window] = mocks.created.mock.calls[0];
    current = false;
    await vi.advanceTimersByTimeAsync(500);
    await checkout;
    expect(window.isDestroyed()).toBe(true);
  });

  it('escapes inline script data and does not turn closure into payment success', () => {
    const html = paymentHtml(
      { ...payment, publishableKey: '</script><script>bad()</script>' },
      'http://127.0.0.1:1/test',
      'nonce'
    );
    expect(html).not.toContain('</script><script>bad()');
    expect(html).toContain("intent.status==='succeeded'");
    expect(html).not.toContain('window.b4m');
  });
});

describe('AccountService', () => {
  function service(get: ReturnType<typeof vi.fn>, signedIn = true) {
    return new AccountService({
      logger: { warn: () => {} },
      getApiClient: () => (signedIn ? ({ get } as unknown as AuthenticatedApiClient) : null),
    });
  }

  describe('readBalance', () => {
    it('reads the balance the endpoint states', () => {
      expect(readBalance({ credits: { balance: 31_667 } })).toBe(31_667);
    });

    // Zero is a real balance and has to survive the parse as one; everything that is not a
    // usable number is "not stated", which the caller reports as unknown.
    it('keeps a zero and rejects anything that is not a usable number', () => {
      expect(readBalance({ credits: { balance: 0 } })).toBe(0);
      expect(readBalance({ credits: { balance: Number.NaN } })).toBeNull();
      expect(readBalance({ credits: { balance: '31667' } })).toBeNull();
      expect(readBalance({ credits: {} })).toBeNull();
      expect(readBalance(null)).toBeNull();
    });
  });

  describe('readExpiring', () => {
    it('reads the schedule soonest first, as epoch ms', () => {
      expect(
        readExpiring({
          credits: {
            expiring: [
              { amount: 300, expires_at: '2027-01-16T00:00:00.000Z' },
              { amount: 120, expires_at: '2026-12-02T00:00:00.000Z' },
            ],
          },
        })
      ).toEqual([
        { amount: 120, expiresAt: Date.parse('2026-12-02T00:00:00.000Z') },
        { amount: 300, expiresAt: Date.parse('2027-01-16T00:00:00.000Z') },
      ]);
    });

    it('reads an empty schedule as nothing expiring, not as unknown', () => {
      expect(readExpiring({ credits: { expiring: [] } })).toEqual([]);
    });

    it('is null when the server stated no schedule', () => {
      expect(readExpiring({ credits: { balance: 10 } })).toBeNull();
      expect(readExpiring(null)).toBeNull();
    });

    it('drops the whole schedule when any entry is malformed, rather than understate what expires', () => {
      for (const bad of [
        { amount: 'many', expires_at: '2026-12-02T00:00:00.000Z' },
        { amount: 0, expires_at: '2026-12-02T00:00:00.000Z' },
        { amount: 10, expires_at: 'soon' },
        null,
      ]) {
        expect(
          readExpiring({ credits: { expiring: [{ amount: 5, expires_at: '2026-12-01T00:00:00.000Z' }, bad] } })
        ).toBeNull();
      }
    });
  });

  describe('readMonthlyAllowance', () => {
    it('keeps a finite backend-stated allowance, including zero', () => {
      expect(readMonthlyAllowance({ credits: { monthly_allowance: 50_000 } })).toBe(50_000);
      expect(readMonthlyAllowance({ credits: { monthly_allowance: 0 } })).toBe(0);
    });

    it('does not invent an allowance from a missing or unusable value', () => {
      expect(readMonthlyAllowance({ credits: {} })).toBeNull();
      expect(readMonthlyAllowance({ credits: { monthly_allowance: -1 } })).toBeNull();
      expect(readMonthlyAllowance({ credits: { monthly_allowance: '50000' } })).toBeNull();
      expect(readMonthlyAllowance(null)).toBeNull();
    });
  });

  describe('AccountService', () => {
    it('submits feedback with the signed-in identity to the web feedback endpoint', async () => {
      const post = vi.fn().mockResolvedValue({ delivery: { channels: { slack: { outcome: 'skipped' } } } });
      const account = new AccountService({
        logger: { warn: () => {} },
        getApiClient: () => ({ post }) as unknown as AuthenticatedApiClient,
      });
      const user = { id: 'u1', username: 'reporter', email: 'r@example.test' };
      const result = await account.sendFeedback('Great app', user);
      expect(result).toEqual({ ok: true });
      expect(post).toHaveBeenCalledWith('/api/feedback', {
        userId: 'u1',
        username: 'reporter',
        userEmail: 'r@example.test',
        tags: ['feedback', 'cs'],
        content: 'Great app',
      });
    });

    it('refuses empty or signed-out submissions without a network call', async () => {
      const post = vi.fn();
      const account = new AccountService({
        logger: { warn: () => {} },
        getApiClient: () => ({ post }) as unknown as AuthenticatedApiClient,
      });
      expect((await account.sendFeedback(' ', { id: 'u1' })).ok).toBe(false);
      expect((await account.sendFeedback('hello')).ok).toBe(false);
      expect(post).not.toHaveBeenCalled();
    });

    it('distinguishes delivery failure and lost text from skipped notifications', async () => {
      const post = vi
        .fn()
        .mockResolvedValueOnce({ delivery: { channels: { email: { outcome: 'failed' } } } })
        .mockResolvedValueOnce({ contentStored: false });
      const account = new AccountService({
        logger: { warn: () => {} },
        getApiClient: () => ({ post }) as unknown as AuthenticatedApiClient,
      });
      const user = { id: 'u1' };
      await expect(account.sendFeedback('hello', user)).resolves.toMatchObject({
        ok: true,
        warning: expect.stringContaining('notify'),
      });
      await expect(account.sendFeedback('hello', user)).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('save'),
      });
    });

    it('reports a failed request without exposing the submitted text', async () => {
      const post = vi.fn().mockRejectedValue(new Error('secret report text'));
      const account = new AccountService({
        logger: { warn: () => {} },
        getApiClient: () => ({ post }) as unknown as AuthenticatedApiClient,
      });
      await expect(account.sendFeedback('secret report text', { id: 'u1' })).resolves.toEqual({
        ok: false,
        error: 'Could not submit your feedback. Please try again.',
      });
    });

    it('forwards the monthly allowance with the personal balance', async () => {
      const get = vi.fn().mockResolvedValue({ credits: { balance: 25_000, monthly_allowance: 50_000 } });
      await expect(service(get).credits()).resolves.toEqual({ balance: 25_000, monthlyAllowance: 50_000 });
    });

    it('retains the allowance when the response omits its balance', async () => {
      const get = vi.fn().mockResolvedValue({ credits: { monthly_allowance: 50_000 } });
      await expect(service(get).credits()).resolves.toMatchObject({ balance: null, monthlyAllowance: 50_000 });
    });

    it('forwards the expiry schedule with the personal balance', async () => {
      const get = vi.fn().mockResolvedValue({
        credits: { balance: 500, expiring: [{ amount: 200, expires_at: '2026-12-02T00:00:00.000Z' }] },
      });
      await expect(service(get).credits()).resolves.toEqual({
        balance: 500,
        monthlyAllowance: null,
        expiring: [{ amount: 200, expiresAt: Date.parse('2026-12-02T00:00:00.000Z') }],
      });
    });

    it('reports the balance from the account endpoint', async () => {
      const get = vi.fn().mockResolvedValue({ credits: { balance: 31_667 } });
      await expect(service(get).credits()).resolves.toEqual({ balance: 31_667, monthlyAllowance: null });
      expect(get).toHaveBeenCalledWith('/api/v1/me');
    });

    it('reports a zero balance as the real figure it is', async () => {
      const get = vi.fn().mockResolvedValue({ credits: { balance: 0 } });
      await expect(service(get).credits()).resolves.toEqual({ balance: 0, monthlyAllowance: null });
    });

    // The distinction the whole nullable balance exists for: a read that failed must not come
    // back looking like an account with nothing left.
    it('reports a failed read as unknown, with a reason, never as zero', async () => {
      const get = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const credits = await service(get).credits();
      expect(credits.balance).toBeNull();
      expect(credits.error).toBeTruthy();
    });

    it('does not reach the network at all when signed out', async () => {
      const get = vi.fn();
      const credits = await service(get, false).credits();
      expect(credits.balance).toBeNull();
      expect(get).not.toHaveBeenCalled();
    });

    it('shares one request between concurrent asks, and reads again after they settle', async () => {
      const get = vi.fn().mockResolvedValue({ credits: { balance: 12 } });
      const account = service(get);

      await Promise.all([account.credits(), account.credits()]);
      expect(get).toHaveBeenCalledTimes(1);

      // No TTL: the next ask is a fresh read, because it only comes after a turn has spent.
      await account.credits();
      expect(get).toHaveBeenCalledTimes(2);
    });
  });

  describe('readPlan', () => {
    const plan = {
      plan_name: 'Professional',
      price_id: 'price_1',
      interval: 'monthly',
      current_period_ends_at: '2026-10-18T00:00:00.000Z',
    };

    it('reads the subscription the endpoint states', () => {
      expect(readPlan({ subscription: plan })).toEqual({
        name: 'Professional',
        interval: 'monthly',
        currentPeriodEndsAt: '2026-10-18T00:00:00.000Z',
      });
    });

    // A row reading "renews Invalid Date" is worse than no row at all.
    it('reports no plan at all rather than a half-stated one', () => {
      expect(readPlan({ subscription: { ...plan, current_period_ends_at: 'soon' } })).toBeNull();
      expect(readPlan({ subscription: { ...plan, interval: 'weekly' } })).toBeNull();
      expect(readPlan({ subscription: { ...plan, plan_name: '' } })).toBeNull();
      expect(readPlan({ subscription: null })).toBeNull();
      expect(readPlan(null)).toBeNull();
    });
  });

  describe('readTier', () => {
    it('keeps a tier the ladder knows and discards anything else', () => {
      expect(readTier({ tier: 'pro' })).toBe('pro');
      expect(readTier({ tier: 'platinum' })).toBeNull();
      expect(readTier({})).toBeNull();
    });
  });

  describe('AccountService.profile', () => {
    // `other` is a paying account whose plan this deployment cannot name. Collapsing it into the
    // null plan would tell a paying customer they are on the free one.
    it('keeps the tier when the server names no plan', async () => {
      const get = vi.fn().mockResolvedValue({ credits: { balance: 10 }, tier: 'other', subscription: null });
      await expect(service(get).profile()).resolves.toEqual({
        credits: { balance: 10, monthlyAllowance: null },
        plan: null,
        tier: 'other',
      });
    });

    it('reads balance and plan from one request, not two', async () => {
      const get = vi.fn().mockResolvedValue({ credits: { balance: 10 }, tier: 'free', subscription: null });
      const account = service(get);
      await Promise.all([account.credits(), account.profile()]);
      expect(get).toHaveBeenCalledTimes(1);
    });
  });
});

describe('BillingService', () => {
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
    const logger = { warn: vi.fn() };
    const billing = new BillingService({ getContext: () => context, openExternal, openCreditPayment, logger });
    return {
      billing,
      get,
      post,
      openExternal,
      openCreditPayment,
      logger,
      setContext: (value: BillingContext | null) => {
        context = value;
      },
    };
  }

  describe('BillingService', () => {
    it('returns the account-bound balance and discards it if identity changes during its read', async () => {
      const { billing, get, setContext } = build();
      get.mockImplementation(async path =>
        path.includes('catalog=desktop')
          ? { billingEnabled: true, plans: [plan] }
          : path === '/api/v1/me'
            ? { credits: { balance: 50000 } }
            : []
      );
      expect((await billing.billing()).balance).toBe(50000);
      get.mockImplementation(async path => {
        if (path === '/api/v1/me') {
          setContext(null);
          return { credits: { balance: 90000 } };
        }
        return path.includes('catalog=desktop') ? { billingEnabled: true, plans: [plan] } : [];
      });
      const result = await billing.billing();
      expect(result.error).toBeTruthy();
      expect(result.balance).toBeUndefined();
    });

    it('keeps plans available when the balance read fails and logs only safe diagnostics', async () => {
      const { billing, get, logger } = build();
      get.mockImplementation(async path => {
        if (path === '/api/v1/me') throw new Error('secret payment details');
        return path.includes('catalog=desktop') ? { billingEnabled: true, plans: [plan] } : [];
      });
      await expect(billing.billing()).resolves.toMatchObject({ balance: null, plans: [plan] });
      expect(logger.warn).toHaveBeenCalledWith('BILLING: balance failed (Error, status unknown)');
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret payment details');
    });

    it.each([
      { error: 'Already subscribed' },
      { error: { message: 'Account cannot purchase' } },
      { message: 'Billing unavailable' },
    ])('returns a server refusal and logs its status without request data', async data => {
      const { billing, post, logger } = build();
      post.mockRejectedValue({ response: { status: 403, data }, config: { headers: { Authorization: 'secret' } } });
      const result = await billing.subscribePlan('price_pro');
      expect(result.ok).toBe(false);
      expect(result).toEqual({
        ok: false,
        error: typeof data.error === 'string' ? data.error : (data.error?.message ?? data.message),
      });
      expect(logger.warn).toHaveBeenCalledWith('BILLING: subscribe failed (unknown, status 403)');
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
    });

    it('logs schema drift and keeps server errors private', async () => {
      const { billing, get, logger } = build();
      get.mockResolvedValue({ bad: 'private' });
      await billing.billing();
      expect(logger.warn).toHaveBeenCalledWith('BILLING: read failed (schema, status unknown)');
    });

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
        balance: null,
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
        allowRedirects: false,
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

    it('reports a credit-purchase refusal without logging payment credentials', async () => {
      const { billing, post, logger } = buildCredits();
      post.mockRejectedValue({ response: { status: 400, data: { error: 'Payments are unavailable' } } });
      await expect(billing.purchaseCredits(pack.id)).resolves.toEqual({ ok: false, error: 'Payments are unavailable' });
      expect(logger.warn).toHaveBeenCalledWith('BILLING: purchase failed (unknown, status 400)');
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

    it('requires accepted terms when the server asks for them and forwards the acceptance', async () => {
      const { billing, get, post } = buildCredits();
      get.mockImplementation(async path =>
        path.includes('catalog=desktop')
          ? {
              billingEnabled: true,
              plans: [plan],
              creditPackages: [pack],
              termsConsentRequired: true,
              termsUrl: 'https://site.example/terms-of-service',
            }
          : []
      );
      await expect(billing.billing()).resolves.toMatchObject({
        termsConsentRequired: true,
        termsUrl: 'https://site.example/terms-of-service',
      });

      for (const accepted of [undefined, false, 'true', 1])
        await expect(billing.purchaseCredits(pack.id, accepted)).resolves.toEqual({
          ok: false,
          error: 'Accept the Terms of Service to buy credits.',
        });
      expect(post).not.toHaveBeenCalled();

      await expect(billing.purchaseCredits(pack.id, true)).resolves.toEqual({ ok: true });
      expect(post).toHaveBeenCalledExactlyOnceWith('/api/stripe/start-payment', {
        transactionType: 'package',
        packageId: pack.id,
        allowRedirects: false,
        acceptedTerms: true,
      });
    });

    it('sends no acceptance and reports no terms requirement when the server does not ask', async () => {
      const { billing, post } = buildCredits();
      expect(await billing.billing()).not.toHaveProperty('termsConsentRequired');
      await expect(billing.purchaseCredits(pack.id, false)).resolves.toEqual({ ok: true });
      expect(post.mock.calls[0][1]).not.toHaveProperty('acceptedTerms');
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
});
