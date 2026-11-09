import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { AccountBilling, SubscribePlanResult } from '@shared/account';
import { z } from 'zod';

const planSchema = z.object({
  priceId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  credits: z.number().finite().nonnegative(),
  interval: z.enum(['monthly', 'yearly']),
  priceCents: z.number().int().nonnegative().nullable(),
  currency: z.literal('usd'),
  features: z.array(z.string()),
});
const catalogSchema = z.object({ billingEnabled: z.boolean(), plans: z.array(planSchema) });
const dateSchema = z.string().datetime({ offset: true }).nullable().optional();
const subscriptionsSchema = z.array(
  z.object({
    priceId: z.string().min(1),
    subscriptionId: z.string().nullable().optional(),
    status: z.string().min(1),
    periodEndsAt: dateSchema,
    canceledAt: dateSchema,
  })
);

export interface BillingContext {
  api: AuthenticatedApiClient;
  environmentUrl: string;
  userId: string;
}

interface BillingServiceDeps {
  getContext(): BillingContext | null;
  openExternal(url: string): Promise<void>;
}

export class BillingService {
  private checkoutInFlight = false;

  constructor(private readonly deps: BillingServiceDeps) {}

  async billing(): Promise<AccountBilling> {
    const context = this.deps.getContext();
    if (!context) return unavailable('Sign in to see subscription plans.');
    try {
      const billing = await this.read(context);
      this.assertCurrent(context);
      return billing;
    } catch {
      return unavailable('Could not load billing from this server. Try again.');
    }
  }

  async subscribePlan(priceId: unknown): Promise<SubscribePlanResult> {
    if (typeof priceId !== 'string' || !priceId || priceId.length > 255) {
      return { ok: false, error: 'Choose an available plan.' };
    }
    if (this.checkoutInFlight) return { ok: false, error: 'Checkout is already opening.' };
    const context = this.deps.getContext();
    if (!context) return { ok: false, error: 'Sign in to subscribe.' };
    this.checkoutInFlight = true;
    try {
      const billing = await this.read(context);
      this.assertCurrent(context);
      if (!billing.billingEnabled) return { ok: false, error: 'Subscriptions are not available on this server.' };
      if (billing.subscriptions.length) {
        return { ok: false, error: 'You already have a subscription. Plan changes are not supported in desktop.' };
      }
      const plan = billing.plans.find(candidate => candidate.priceId === priceId);
      if (!plan || plan.priceCents === null) return { ok: false, error: 'This plan is not available.' };
      const callbackUrl = checkoutCallback(context.environmentUrl);
      const response = await context.api.post<unknown>('/api/subscriptions/subscribe', {
        priceId,
        callbackUrl,
        attributionConsent: false,
      });
      this.assertCurrent(context);
      const { sessionUrl } = z.object({ sessionUrl: z.string() }).parse(response);
      if (!isStripeCheckoutUrl(sessionUrl)) throw new Error('Invalid checkout URL');
      await this.deps.openExternal(sessionUrl);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not open checkout. Check your connection and try again.' };
    } finally {
      this.checkoutInFlight = false;
    }
  }

  private async read(context: BillingContext): Promise<AccountBilling> {
    const [catalog, rows] = await Promise.all([
      context.api.get<unknown>('/api/stripe/subscription-plans?catalog=personal'),
      context.api.get<unknown>('/api/subscriptions/own'),
    ]);
    const { billingEnabled, plans } = catalogSchema.parse(catalog);
    const subscriptions = subscriptionsSchema
      .parse(rows)
      .filter(row => row.status !== 'canceled' && row.status !== 'incomplete_expired')
      .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'))
      .map(row => ({
        priceId: row.priceId,
        subscriptionId: row.subscriptionId ?? null,
        status: row.status,
        periodEndsAt: row.periodEndsAt ?? null,
        canceledAt: row.canceledAt ?? null,
      }));
    return { billingEnabled, plans, subscriptions };
  }

  private assertCurrent(context: BillingContext): void {
    const current = this.deps.getContext();
    if (!current || !sameContext(current, context)) throw new Error('Account changed');
  }
}

function sameContext(a: BillingContext, b: BillingContext): boolean {
  return a.api === b.api && a.userId === b.userId && a.environmentUrl === b.environmentUrl;
}

function unavailable(error: string): AccountBilling {
  return { billingEnabled: false, plans: [], subscriptions: [], error };
}

export function checkoutCallback(environmentUrl: string): string {
  const base = new URL(environmentUrl);
  if (
    base.username ||
    base.password ||
    (base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
  )
    throw new Error('Invalid billing environment');
  return new URL('/?billing=plans', base.origin).href;
}

export function isStripeCheckoutUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'checkout.stripe.com' &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      /^\/c\/pay\/cs_(?:test_|live_)?[A-Za-z0-9]+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
