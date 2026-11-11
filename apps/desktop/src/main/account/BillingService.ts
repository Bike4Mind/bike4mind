import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { AccountBilling, SubscribePlanResult } from '@shared/account';
import { z } from 'zod';
import type { CreditPayment } from './CreditPaymentWindow';
import { readBalance } from './AccountService';

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
const catalogSchema = z.object({
  billingEnabled: z.boolean(),
  plans: z.array(planSchema),
  creditPackages: z
    .array(
      z.object({
        id: z.string().min(1),
        price: z.number().finite().positive(),
        credits: z.number().int().positive(),
        description: z.string(),
      })
    )
    .optional(),
});
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
  logger: { warn(message: string): void };
  getContext(): BillingContext | null;
  openExternal(url: string): Promise<void>;
  openCreditPayment(payment: CreditPayment, isCurrent: () => boolean): Promise<void>;
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
    } catch (error) {
      this.logFailure('read', error);
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
    } catch (error) {
      this.logFailure('subscribe', error);
      return {
        ok: false,
        error: refusalMessage(error) ?? 'Could not open checkout. Check your connection and try again.',
      };
    } finally {
      this.checkoutInFlight = false;
    }
  }

  async purchaseCredits(packageId: unknown): Promise<SubscribePlanResult> {
    if (typeof packageId !== 'string' || !packageId || packageId.length > 255)
      return { ok: false, error: 'Choose an available credit pack.' };
    if (this.checkoutInFlight) return { ok: false, error: 'Checkout is already open.' };
    const context = this.deps.getContext();
    if (!context) return { ok: false, error: 'Sign in to buy credits.' };
    this.checkoutInFlight = true;
    try {
      const billing = await this.read(context);
      this.assertCurrent(context);
      const pack = billing.creditPackages?.find(pack => pack.id === packageId);
      if (!billing.billingEnabled || !pack) return { ok: false, error: 'This credit pack is not available.' };
      const response = await context.api.post<unknown>('/api/stripe/start-payment', {
        transactionType: 'package',
        packageId,
        allowRedirects: false,
      });
      this.assertCurrent(context);
      const payment = z
        .object({
          clientSecret: z.string().regex(/^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/),
          publishableKey: z.string().regex(/^pk_(test|live)_[A-Za-z0-9]+$/),
        })
        .parse(response);
      await this.deps.openCreditPayment({ ...payment, credits: pack.credits, price: pack.price }, () => {
        const current = this.deps.getContext();
        return !!current && sameContext(current, context);
      });
      this.assertCurrent(context);
      return { ok: true };
    } catch (error) {
      this.logFailure('purchase', error);
      return {
        ok: false,
        error: refusalMessage(error) ?? 'Could not complete credit checkout. Refresh your balance before trying again.',
      };
    } finally {
      this.checkoutInFlight = false;
    }
  }

  private async read(context: BillingContext): Promise<AccountBilling> {
    const [catalog, rows, balance] = await Promise.all([
      context.api.get<unknown>('/api/stripe/subscription-plans?catalog=desktop'),
      context.api.get<unknown>('/api/subscriptions/own'),
      context.api
        .get<unknown>('/api/v1/me')
        .then(readBalance)
        .catch(error => {
          this.logFailure('balance', error);
          return null;
        }),
    ]);
    const { billingEnabled, plans, creditPackages } = catalogSchema.parse(catalog);
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
    this.assertCurrent(context);
    return { billingEnabled, balance, plans, subscriptions, ...(creditPackages && { creditPackages }) };
  }

  private logFailure(operation: string, error: unknown): void {
    const response = errorResponse.safeParse(error);
    const status = response.success ? response.data.response.status : 'unknown';
    const kind = error instanceof z.ZodError ? 'schema' : error instanceof Error ? error.name : 'unknown';
    this.deps.logger.warn(`BILLING: ${operation} failed (${kind}, status ${status})`);
  }

  private assertCurrent(context: BillingContext): void {
    const current = this.deps.getContext();
    if (!current || !sameContext(current, context)) throw new Error('Account changed');
  }
}

function sameContext(a: BillingContext, b: BillingContext): boolean {
  return a.api === b.api && a.userId === b.userId && a.environmentUrl === b.environmentUrl;
}

const errorResponse = z.object({ response: z.object({ status: z.number(), data: z.unknown().optional() }) });

function refusalMessage(error: unknown): string | null {
  const parsed = errorResponse.safeParse(error);
  if (!parsed.success || parsed.data.response.status < 400 || parsed.data.response.status >= 500) return null;
  const body = z
    .object({
      error: z.union([z.string(), z.object({ message: z.string() })]).optional(),
      message: z.string().optional(),
    })
    .safeParse(parsed.data.response.data);
  if (!body.success) return null;
  const message =
    typeof body.data.error === 'string' ? body.data.error : (body.data.error?.message ?? body.data.message);
  return message &&
    message.length <= 500 &&
    !Array.from(message).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    ? message
    : null;
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
