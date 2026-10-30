import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { emitMetric } from '@bike4mind/server-utils/utils/cloudwatch';
import {
  handleUserSubscriptionInvoice,
  handleOrganizationSubscriptionInvoice,
} from '@workers/lib/userSubscriptions/serverUtils';
import { handler } from './invoicePaymentSucceeded';
import { unlockSignupGrantFromSubscription } from '@server/credits/subscriptionUnlock';
import { emitProductEvent } from '@server/analytics/emitActiveEvent';
import { stableEventId } from '@server/analytics/signupEvents';
import { userRepository } from '@bike4mind/database';
import { postNewPaidSubscriptionToSlack } from '@server/integrations/slack/subscriptionLifecycle';

vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  stripe: {
    invoices: { retrieve: vi.fn() },
    subscriptions: { retrieve: vi.fn() },
  },
}));

vi.mock('@server/utils/eventBus', () => ({
  StripeEvents: {
    InvoicePaymentSucceeded: { schema: { parse: (x: unknown) => x } },
  },
}));

vi.mock('@workers/lib/userSubscriptions/serverUtils', () => ({
  handleUserSubscriptionInvoice: vi.fn().mockResolvedValue(undefined),
  handleOrganizationSubscriptionInvoice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({
  emitMetric: vi.fn().mockResolvedValue(undefined),
}));

// Fixtures set metadata.stage: 'test'; pin the current stage to match so the
// guard falls through for same-stage events (and trips on mismatch).
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { STAGE: 'test' },
}));

vi.mock('@workers/utils/eventContext', () => ({
  withEventContext: (h: any) => h,
}));

vi.mock('@server/integrations/slack/subscriptionLifecycle', () => ({
  postNewPaidSubscriptionToSlack: vi.fn().mockResolvedValue(undefined),
}));

// The real source-product emitter runs (signupEvents.ts); only the network edge is mocked, with
// ingest keys for two made-up products.
vi.mock('@server/analytics/emitActiveEvent', () => ({
  HOST_PRODUCT_ID: 'bike4mind',
  emitProductEvent: vi.fn().mockResolvedValue(undefined),
  ingestKeyFor: (p: string) => (p === 'widgets' || p === 'gadgets' ? 'key' : undefined),
}));

vi.mock('@server/credits/subscriptionUnlock', () => ({
  unlockSignupGrantFromSubscription: vi.fn().mockResolvedValue({ creditsGranted: 0, currentCredits: null }),
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: vi.fn().mockResolvedValue(null) },
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const buildSub = (metadata: Record<string, string>, status = 'active') => ({
  id: 'sub_inv_u',
  status,
  metadata,
  items: { data: [{ price: { id: 'price_pro' } }] },
});

const run = () => handler({ properties: { invoiceId: 'in_1', subscriptionId: 'sub_inv_u' } } as any, logger as any);

describe('invoicePaymentSucceeded — stage guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (stripe.invoices.retrieve as any).mockResolvedValue({ id: 'in_1' });
  });

  it('skips (no credit-granting handler) when metadata.stage does not match the current stage', async () => {
    (stripe.subscriptions.retrieve as any).mockResolvedValue(
      buildSub({ userId: 'u1', stage: 'production', ownerType: 'User' })
    );

    await run();

    expect(handleUserSubscriptionInvoice).not.toHaveBeenCalled();
    expect(handleOrganizationSubscriptionInvoice).not.toHaveBeenCalled();
    expect(emitMetric).toHaveBeenCalledWith(
      'Lumina5/Entitlements',
      'EntitlementSkipped',
      1,
      expect.objectContaining({ reason: 'stage_mismatch' })
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('does not match current stage'));
  });

  it('processes the invoice when metadata.stage matches the current stage', async () => {
    (stripe.subscriptions.retrieve as any).mockResolvedValue(
      buildSub({ userId: 'u1', stage: 'test', ownerType: 'User' })
    );

    await run();

    expect(handleUserSubscriptionInvoice).toHaveBeenCalledTimes(1);
    expect(emitMetric).not.toHaveBeenCalledWith(
      'Lumina5/Entitlements',
      'EntitlementSkipped',
      1,
      expect.objectContaining({ reason: 'stage_mismatch' })
    );
  });

  it('processes legacy invoices with no stage (falls through unchanged)', async () => {
    (stripe.subscriptions.retrieve as any).mockResolvedValue(buildSub({ userId: 'u1', ownerType: 'User' }));

    await run();

    expect(handleUserSubscriptionInvoice).toHaveBeenCalledTimes(1);
  });
});

describe('invoicePaymentSucceeded - purchase credited to the source product', () => {
  const payer = { id: 'u1', acquisition: { firstTouch: { source: 'widgets' }, lastTouch: { source: 'gadgets' } } };
  type Invoice = Awaited<ReturnType<typeof stripe.invoices.retrieve>>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(emitProductEvent).mockResolvedValue(undefined);
    vi.mocked(userRepository.findById).mockResolvedValue(payer as never);
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(
      buildSub({
        userId: 'u1',
        stage: 'test',
        ownerType: 'User',
        // Checkout's own attribution metadata is NOT what is read: the stored signup touches are.
        acq_first_source: 'elsewhere',
      }) as Awaited<ReturnType<typeof stripe.subscriptions.retrieve>>
    );
  });

  const invoice = (over: Record<string, unknown> = {}) =>
    vi.mocked(stripe.invoices.retrieve).mockResolvedValue({
      id: 'in_1',
      billing_reason: 'subscription_create',
      amount_paid: 2999,
      currency: 'usd',
      ...over,
    } as unknown as Invoice);

  it.each(['subscription_create', 'subscription_cycle', 'subscription_update'])(
    'credits a paid %s invoice to each product the payer came through, keyed on the invoice',
    async billingReason => {
      invoice({ billing_reason: billingReason });

      await run();

      expect(handleUserSubscriptionInvoice).toHaveBeenCalledOnce();
      expect(userRepository.findById).toHaveBeenCalledWith('u1');
      expect(
        vi.mocked(emitProductEvent).mock.calls.map(([c]) => [c.productId, c.event, c.eventId, c.metadata])
      ).toEqual([
        [
          'widgets',
          'purchase',
          stableEventId('purchase', 'widgets', 'in_1'),
          {
            touch: 'first',
            attribution: 'self-reported',
            kind: 'subscription',
            value: 29.99,
            currency: 'USD',
            billingReason,
            userAction: false,
          },
        ],
        [
          'gadgets',
          'purchase',
          stableEventId('purchase', 'gadgets', 'in_1'),
          expect.objectContaining({ touch: 'last' }),
        ],
      ]);
    }
  );

  it('sends nothing for a zero-amount invoice (a trial)', async () => {
    invoice({ amount_paid: 0 });
    await run();
    expect(handleUserSubscriptionInvoice).toHaveBeenCalledOnce();
    expect(emitProductEvent).not.toHaveBeenCalled();
  });

  it("does not credit an organization invoice from the checkout user's signup touches", async () => {
    invoice();
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(
      buildSub({ userId: 'u1', stage: 'test', ownerType: 'Organization', organizationId: 'org1' }) as Awaited<
        ReturnType<typeof stripe.subscriptions.retrieve>
      >
    );

    await run();

    expect(handleOrganizationSubscriptionInvoice).toHaveBeenCalledOnce();
    expect(userRepository.findById).not.toHaveBeenCalled();
    expect(emitProductEvent).not.toHaveBeenCalled();
  });

  it('does not credit a malformed organization invoice when the legacy parser drops its owner type', async () => {
    invoice();
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(
      buildSub({ userId: 'u1', stage: 'test', ownerType: 'Organization' }) as Awaited<
        ReturnType<typeof stripe.subscriptions.retrieve>
      >
    );

    await run();

    expect(userRepository.findById).not.toHaveBeenCalled();
    expect(emitProductEvent).not.toHaveBeenCalled();
  });

  it('still credits a paid legacy user invoice with no owner type', async () => {
    invoice();
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(
      buildSub({ userId: 'u1', stage: 'test' }) as Awaited<ReturnType<typeof stripe.subscriptions.retrieve>>
    );

    await run();

    expect(handleUserSubscriptionInvoice).toHaveBeenCalledOnce();
    expect(emitProductEvent).toHaveBeenCalledTimes(2);
  });

  it('sends nothing for a synthetic payer or one with no stored acquisition', async () => {
    invoice();
    vi.mocked(userRepository.findById).mockResolvedValue({ ...payer, isSynthetic: true } as never);
    await run();
    vi.mocked(userRepository.findById).mockResolvedValue({ id: 'u1' } as never);
    await run();
    expect(emitProductEvent).not.toHaveBeenCalled();
  });

  it('sends nothing for a skipped foreign-stage invoice', async () => {
    invoice();
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(
      buildSub({ userId: 'u1', stage: 'production', ownerType: 'User' }) as Awaited<
        ReturnType<typeof stripe.subscriptions.retrieve>
      >
    );
    await run();
    expect(emitProductEvent).not.toHaveBeenCalled();
  });

  it('still succeeds when the payer lookup or the emit fails', async () => {
    invoice();
    vi.mocked(emitProductEvent).mockRejectedValue(new Error('down'));
    await expect(run()).resolves.toBeUndefined();

    vi.mocked(userRepository.findById).mockRejectedValue(new Error('db down'));
    await expect(run()).resolves.toBeUndefined();
  });
});

describe('invoicePaymentSucceeded - new paid subscription Slack post', () => {
  type Invoice = Awaited<ReturnType<typeof stripe.invoices.retrieve>>;
  type Subscription = Awaited<ReturnType<typeof stripe.subscriptions.retrieve>>;
  const sub = buildSub({ userId: 'u1', stage: 'test', ownerType: 'User' }) as unknown as Subscription;
  const invoice = (over: Record<string, unknown>) =>
    vi.mocked(stripe.invoices.retrieve).mockResolvedValue({
      id: 'in_1',
      billing_reason: 'subscription_create',
      amount_paid: 2999,
      currency: 'usd',
      ...over,
    } as unknown as Invoice);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(sub);
  });

  it('announces the paid invoice that opened the subscription, after the handler recorded it', async () => {
    invoice({});

    await run();

    expect(postNewPaidSubscriptionToSlack).toHaveBeenCalledOnce();
    expect(postNewPaidSubscriptionToSlack).toHaveBeenCalledWith(expect.objectContaining({ id: 'in_1' }), sub);
    expect(vi.mocked(handleUserSubscriptionInvoice).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(postNewPaidSubscriptionToSlack).mock.invocationCallOrder[0]
    );
  });

  it('skips a $0 opening invoice', async () => {
    invoice({ amount_paid: 0 });

    await run();

    expect(postNewPaidSubscriptionToSlack).not.toHaveBeenCalled();
  });

  it.each(['subscription_cycle', 'subscription_update'])('posts nothing for a %s invoice', async billingReason => {
    invoice({ billing_reason: billingReason });

    await run();

    expect(postNewPaidSubscriptionToSlack).not.toHaveBeenCalled();
  });

  it('posts nothing when the invoice handler fails, so a retry cannot post twice', async () => {
    invoice({});
    vi.mocked(handleUserSubscriptionInvoice).mockRejectedValueOnce(new Error('write failed'));

    await expect(run()).rejects.toThrow('write failed');

    expect(postNewPaidSubscriptionToSlack).not.toHaveBeenCalled();
  });
});

describe('invoicePaymentSucceeded - signup grant unblock', () => {
  const stubInvoice = (amountPaid: number) => {
    (stripe.invoices.retrieve as any).mockResolvedValue({ id: 'in_1', amount_paid: amountPaid, currency: 'usd' });
    (stripe.subscriptions.retrieve as any).mockResolvedValue(
      buildSub({ userId: 'u1', stage: 'test', ownerType: 'User' })
    );
  };
  beforeEach(() => vi.clearAllMocks());

  it('releases the signup grant on a paid invoice', async () => {
    stubInvoice(2000);
    await run();
    expect(unlockSignupGrantFromSubscription).toHaveBeenCalledWith('u1', expect.anything());
  });

  it.each([[0], [undefined as unknown as number]])('does not release on a $0 invoice (%s)', async amount => {
    stubInvoice(amount);
    await run();
    expect(unlockSignupGrantFromSubscription).not.toHaveBeenCalled();
  });

  it('does not release, and warns, when the subscription is not active', async () => {
    (stripe.invoices.retrieve as any).mockResolvedValue({ id: 'in_1', amount_paid: 2000, currency: 'usd' });
    (stripe.subscriptions.retrieve as any).mockResolvedValue(
      buildSub({ userId: 'u1', stage: 'test', ownerType: 'User' }, 'incomplete')
    );
    await run();
    expect(unlockSignupGrantFromSubscription).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('does not release for an organization subscription', async () => {
    (stripe.invoices.retrieve as any).mockResolvedValue({ id: 'in_1', amount_paid: 2000, currency: 'usd' });
    (stripe.subscriptions.retrieve as any).mockResolvedValue(
      buildSub({ userId: 'u1', stage: 'test', ownerType: 'Organization', organizationId: 'o1' })
    );
    await run();
    expect(unlockSignupGrantFromSubscription).not.toHaveBeenCalled();
  });

  it('does not fail the handler when the release throws', async () => {
    stubInvoice(2000);
    vi.mocked(unlockSignupGrantFromSubscription).mockRejectedValueOnce(new Error('boom'));
    await expect(run()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
