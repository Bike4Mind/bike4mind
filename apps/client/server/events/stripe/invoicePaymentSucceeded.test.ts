import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stripe } from '@server/integrations/stripe/stripe';
import { emitMetric } from '@server/utils/cloudwatch';
import {
  handleUserSubscriptionInvoice,
  handleOrganizationSubscriptionInvoice,
} from '@client/lib/userSubscriptions/serverUtils';
import { handler } from './invoicePaymentSucceeded';

vi.mock('@server/integrations/stripe/stripe', () => ({
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

vi.mock('@client/lib/userSubscriptions/serverUtils', () => ({
  handleUserSubscriptionInvoice: vi.fn().mockResolvedValue(undefined),
  handleOrganizationSubscriptionInvoice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@server/utils/cloudwatch', () => ({
  emitMetric: vi.fn().mockResolvedValue(undefined),
}));

// Fixtures set metadata.stage: 'test'; pin the current stage to match so the
// guard falls through for same-stage events (and trips on mismatch).
vi.mock('@server/utils/config', () => ({
  Config: { STAGE: 'test' },
}));

vi.mock('../utils', () => ({
  withEventContext: (h: any) => h,
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const buildSub = (metadata: Record<string, string>) => ({
  id: 'sub_inv_u',
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
