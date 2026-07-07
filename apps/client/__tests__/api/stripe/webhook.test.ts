import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// All mocks must be declared before any imports

// Capture the POST handler function from baseApi().post(handler)
// so we can call it directly without going through the HTTP stack.
let capturedHandler: ((req: Request, res: Response) => Promise<void>) | null = null;
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: vi.fn().mockReturnValue({
    post: vi.fn().mockImplementation((handler: (req: Request, res: Response) => Promise<void>) => {
      capturedHandler = handler;
      // Return something that looks like a next-connect handler (with default export shape)
      return handler;
    }),
  }),
}));

const mockFindByPaymentIntentId = vi.fn();
const mockFindByStripeCustomerId = vi.fn();
const mockFindByOrgStripeCustomerId = vi.fn();
const mockFindById = vi.fn();
const mockUserUpdate = vi.fn();
const mockSubtractCredits = vi.fn();
const mockStampCreditLot = vi.fn();
const mockClawbackCreditLotsByStripeRef = vi.fn();
const mockUpdateTransactionStatus = vi.fn();
const mockUpdateByStripeSubscriptionId = vi.fn();
const mockPostMessageToSlack = vi.fn();
const mockSendToClient = vi.fn();
const mockStripeChargesRetrieve = vi.fn();
const mockConstructEvent = vi.fn();

vi.mock('@bike4mind/database', () => ({
  creditLotRepository: {},
  creditTransactionRepository: {
    findByPaymentIntentId: (...args: unknown[]) => mockFindByPaymentIntentId(...args),
    updateTransactionStatus: (...args: unknown[]) => mockUpdateTransactionStatus(...args),
    createTransaction: vi.fn().mockResolvedValue({ id: 'tx_created' }),
  },
  organizationRepository: {
    findByStripeCustomerId: (...args: unknown[]) => mockFindByOrgStripeCustomerId(...args),
  },
  userRepository: {
    findByStripeCustomerId: (...args: unknown[]) => mockFindByStripeCustomerId(...args),
    findById: (...args: unknown[]) => mockFindById(...args),
    update: (...args: unknown[]) => mockUserUpdate(...args),
    incrementCredits: vi.fn(),
  },
}));

vi.mock('@bike4mind/services', () => ({
  creditService: {
    subtractCredits: (...args: unknown[]) => mockSubtractCredits(...args),
    stampCreditLot: (...args: unknown[]) => mockStampCreditLot(...args),
    clawbackCreditLotsByStripeRef: (...args: unknown[]) => mockClawbackCreditLotsByStripeRef(...args),
  },
}));

vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    updateByStripeSubscriptionId: (...args: unknown[]) => mockUpdateByStripeSubscriptionId(...args),
  },
}));

vi.mock('@server/integrations/slack/slack', () => ({
  postMessageToSlack: (...args: unknown[]) => mockPostMessageToSlack(...args),
}));

vi.mock('@server/websocket/utils', () => ({
  sendToClient: (...args: unknown[]) => mockSendToClient(...args),
}));

vi.mock('@server/integrations/stripe/stripe', () => ({
  isStripeConfigured: vi.fn().mockReturnValue(true),
  stripe: {
    webhooks: { constructEvent: (...args: unknown[]) => mockConstructEvent(...args) },
    charges: { retrieve: (...args: unknown[]) => mockStripeChargesRetrieve(...args) },
  },
  customerExists: vi.fn(),
  CustomerType: { User: 'user', Organization: 'organization' },
}));

vi.mock('@server/utils/config', () => ({
  Config: {
    MONGODB_URI: 'mongodb://localhost/test',
    STAGE: 'test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
  },
  isDevelopment: vi.fn().mockReturnValue(true),
}));

vi.mock('@server/utils/eventBus', () => ({
  StripeEvents: { InvoicePaymentSucceeded: { publish: vi.fn() } },
}));

vi.mock('@server/utils/errors', () => ({
  BadRequestError: class BadRequestError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'BadRequestError';
    }
  },
}));

vi.mock('sst', () => ({
  Resource: {
    App: { stage: 'test' },
    websocket: { managementEndpoint: 'wss://test' },
  },
}));

vi.mock('@bike4mind/common', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/common')>();
  return {
    ...actual,
    isPlaceholderValue: vi.fn().mockReturnValue(false),
  };
});

// Imports after mocks
import { CreditPurchaseStatus } from '@bike4mind/common';

// Load the module to trigger mock capture
// This import triggers `baseApi().post(handler)` which populates capturedHandler
await import('../../../pages/api/stripe/webhook');

// Test helpers

function makeReqRes(eventObj: unknown): { req: Partial<Request>; res: ReturnType<typeof makeMockRes> } {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
    updateMetadata: vi.fn(),
  };

  // Simulate the parsed event (in dev mode, isDevelopment() is true so constructEvent is NOT called)
  // but we set up constructEvent just in case
  mockConstructEvent.mockReturnValue(eventObj);

  const req = {
    ip: '127.0.0.1',
    method: 'POST',
    url: '/api/stripe/webhook',
    headers: { 'stripe-signature': 'sig_test' },
    logger,
    // Provide a resolved JSON body directly (bypass body-reading loop)
    // We simulate the parsed event by having isDevelopment = true so the
    // handler uses JSON.parse(rawBody) - we fake the raw body via chunks
    [Symbol.asyncIterator]: () => {
      const chunks = [Buffer.from(JSON.stringify(eventObj))];
      let idx = 0;
      return {
        next: async () => {
          if (idx < chunks.length) {
            return { value: chunks[idx++], done: false as const };
          }
          return { value: undefined as unknown as Buffer, done: true as const };
        },
      };
    },
  } as unknown as Request;

  const res = makeMockRes();
  return { req, res };
}

function makeMockRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    once: vi.fn(),
    statusCode: 200,
  };
  return res as unknown as Response & typeof res;
}

async function invokeWebhookWithEvent(eventObj: unknown) {
  if (!capturedHandler) throw new Error('capturedHandler not set — webhook module not loaded');
  const { req, res } = makeReqRes(eventObj);
  await capturedHandler(req, res);
  return { req, res };
}

// Tests

describe('Stripe webhook — new fraud prevention handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish implementations that must survive clearAllMocks
    mockPostMessageToSlack.mockResolvedValue(undefined);
    mockUserUpdate.mockResolvedValue(undefined);
    mockUpdateByStripeSubscriptionId.mockResolvedValue(undefined);
    mockUpdateTransactionStatus.mockResolvedValue(undefined);
    mockStampCreditLot.mockResolvedValue(undefined);
    mockClawbackCreditLotsByStripeRef.mockResolvedValue(undefined);
  });

  describe('payment_intent.succeeded', () => {
    const mockUser = { id: 'user123', currentCredits: 100 };

    const packEvent = {
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_pack',
          object: 'payment_intent',
          customer: 'cus_123',
          amount: 999,
          payment_method_types: ['card'],
          metadata: { environment: 'test', credits: '500', packageId: 'pkg_1' },
        },
      },
    };

    it('grants credits and stamps a pack credit lot with the payment intent as stripeRef', async () => {
      mockFindByStripeCustomerId.mockResolvedValue({ ...mockUser });

      await invokeWebhookWithEvent(packEvent);

      expect(mockUserUpdate).toHaveBeenCalledWith(expect.objectContaining({ currentCredits: 600 }));
      expect(mockStampCreditLot).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: 'user123',
          amount: 500,
          grantType: 'purchase',
          stripeRef: 'pi_pack',
        }),
        expect.anything()
      );
    });
  });

  describe('charge.dispute.created', () => {
    const mockUser = {
      id: 'user123',
      name: 'Test User',
      email: 'test@example.com',
      currentCredits: 500,
      disputePending: false,
    };
    const mockTx = { id: 'tx1', ownerId: 'user123', credits: 200, stripePaymentIntentId: 'pi_123' };
    const disputeEvent = {
      type: 'charge.dispute.created',
      data: {
        object: {
          id: 'dp_abc',
          payment_intent: 'pi_123',
          charge: 'ch_456',
          amount: 2000,
          currency: 'usd',
          reason: 'fraudulent',
        },
      },
    };

    it('clawbacks the correct credits and sets disputePending', async () => {
      mockFindByPaymentIntentId.mockResolvedValue(mockTx);
      mockFindById.mockResolvedValue({ ...mockUser });
      mockSubtractCredits.mockResolvedValue({ currentCredits: 300 });

      await invokeWebhookWithEvent(disputeEvent);

      expect(mockSubtractCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'generic_deduct',
          ownerId: 'user123',
          credits: 200,
          reason: 'dispute_clawback',
          stripeDisputeId: 'dp_abc',
        }),
        expect.anything()
      );

      const updatedUser = mockUserUpdate.mock.calls[0][0];
      expect(updatedUser.disputePending).toBe(true);

      expect(mockClawbackCreditLotsByStripeRef).toHaveBeenCalledWith('pi_123', 'full', 200, expect.anything());
    });

    it('sends a Slack alert with dispute details', async () => {
      mockFindByPaymentIntentId.mockResolvedValue(mockTx);
      mockFindById.mockResolvedValue({ ...mockUser });
      mockSubtractCredits.mockResolvedValue({ currentCredits: 300 });

      await invokeWebhookWithEvent(disputeEvent);

      expect(mockPostMessageToSlack).toHaveBeenCalledWith(expect.stringContaining('dp_abc'));
    });

    it('is idempotent — duplicate dispute event is swallowed (code 11000)', async () => {
      mockFindByPaymentIntentId.mockResolvedValue(mockTx);
      mockFindById.mockResolvedValue({ ...mockUser });
      // Simulate MongoDB duplicate key error
      mockSubtractCredits.mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));

      // Should not throw - duplicate key is a no-op
      await expect(invokeWebhookWithEvent(disputeEvent)).resolves.not.toThrow();
    });

    it('sends Slack alert and skips clawback when user not found', async () => {
      mockFindByPaymentIntentId.mockResolvedValue(null);
      mockStripeChargesRetrieve.mockResolvedValue({ customer: 'cus_unknown' });
      mockFindByStripeCustomerId.mockResolvedValue(null);
      mockFindByOrgStripeCustomerId.mockResolvedValue(null);

      await invokeWebhookWithEvent(disputeEvent);

      expect(mockSubtractCredits).not.toHaveBeenCalled();
      expect(mockPostMessageToSlack).toHaveBeenCalledWith(expect.stringContaining('No User Found'));
      expect(mockClawbackCreditLotsByStripeRef).not.toHaveBeenCalled();
    });
  });

  describe('charge.dispute.closed', () => {
    const mockUser = {
      id: 'user123',
      name: 'Test User',
      email: 'test@example.com',
      currentCredits: 300,
      disputePending: true,
    };
    const mockTx = { id: 'tx1', ownerId: 'user123', stripePaymentIntentId: 'pi_123' };

    function makeDisputeClosedEvent(status: string) {
      return {
        type: 'charge.dispute.closed',
        data: {
          object: {
            id: 'dp_close_abc',
            status,
            payment_intent: 'pi_123',
            charge: 'ch_456',
            amount: 2000,
            currency: 'usd',
          },
        },
      };
    }

    it('clears disputePending and alerts Slack when merchant wins', async () => {
      mockFindByPaymentIntentId.mockResolvedValue(mockTx);
      mockFindById.mockResolvedValue({ ...mockUser });

      await invokeWebhookWithEvent(makeDisputeClosedEvent('won'));

      const updatedUser = mockUserUpdate.mock.calls[0][0];
      expect(updatedUser.disputePending).toBe(false);
      expect(mockPostMessageToSlack).toHaveBeenCalledWith(expect.stringContaining('dp_close_abc'));
    });

    it('takes no action when dispute is lost', async () => {
      await invokeWebhookWithEvent(makeDisputeClosedEvent('lost'));

      expect(mockUserUpdate).not.toHaveBeenCalled();
      expect(mockPostMessageToSlack).not.toHaveBeenCalled();
    });

    it('takes no action when dispute closes as warning_closed', async () => {
      await invokeWebhookWithEvent(makeDisputeClosedEvent('warning_closed'));

      expect(mockUserUpdate).not.toHaveBeenCalled();
      expect(mockPostMessageToSlack).not.toHaveBeenCalled();
    });

    it('logs a warning when user cannot be found for a won dispute', async () => {
      mockFindByPaymentIntentId.mockResolvedValue(null);
      mockStripeChargesRetrieve.mockResolvedValue({ customer: 'cus_unknown' });
      mockFindByStripeCustomerId.mockResolvedValue(null);

      const { req } = await invokeWebhookWithEvent(makeDisputeClosedEvent('won'));

      expect(mockUserUpdate).not.toHaveBeenCalled();
      expect((req as { logger: { warn: ReturnType<typeof vi.fn> } }).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('dp_close_abc')
      );
    });
  });

  describe('charge.refunded', () => {
    it('clawbacks 50% of credits on a 50% refund', async () => {
      const mockUser = { id: 'user123', name: 'Test', email: 'test@example.com' };
      const mockTx = { id: 'tx1', ownerId: 'user123', credits: 1000, stripePaymentIntentId: 'pi_ref' };

      mockFindByPaymentIntentId.mockResolvedValue(mockTx);
      mockFindById.mockResolvedValue(mockUser);
      mockSubtractCredits.mockResolvedValue({ currentCredits: 500 });

      const refundEvent = {
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_refund',
            payment_intent: 'pi_ref',
            amount: 2000,
            amount_captured: 2000,
            refunds: { data: [{ id: 're_test', amount: 1000 }] }, // 50%
          },
        },
      };

      await invokeWebhookWithEvent(refundEvent);

      expect(mockSubtractCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'generic_deduct',
          ownerId: 'user123',
          credits: 500, // 50% of 1000 purchased credits
          reason: 'refund_clawback',
          stripeRefundId: 're_test',
        }),
        expect.anything()
      );

      expect(mockClawbackCreditLotsByStripeRef).toHaveBeenCalledWith('pi_ref', 'proportional', 500, expect.anything());
    });

    it('is idempotent — duplicate refund event is swallowed (code 11000)', async () => {
      const mockUser = { id: 'user123', name: 'Test', email: 'test@example.com' };
      const mockTx = { id: 'tx1', ownerId: 'user123', credits: 1000, stripePaymentIntentId: 'pi_dup' };

      mockFindByPaymentIntentId.mockResolvedValue(mockTx);
      mockFindById.mockResolvedValue(mockUser);
      mockSubtractCredits.mockRejectedValue(Object.assign(new Error('E11000'), { code: 11000 }));

      const refundEvent = {
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_dup',
            payment_intent: 'pi_dup',
            amount: 2000,
            amount_captured: 2000,
            refunds: { data: [{ id: 're_dup', amount: 2000 }] },
          },
        },
      };

      await expect(invokeWebhookWithEvent(refundEvent)).resolves.not.toThrow();
    });

    it('clawbacks each refund independently on multi-partial-refund charges', async () => {
      const mockUser = { id: 'user123', name: 'Test', email: 'test@example.com' };
      const mockTx = { id: 'tx1', ownerId: 'user123', credits: 1000, stripePaymentIntentId: 'pi_multi' };

      mockFindByPaymentIntentId.mockResolvedValue(mockTx);
      mockFindById.mockResolvedValue(mockUser);
      mockSubtractCredits.mockResolvedValue({ currentCredits: 300 });

      const multiRefundEvent = {
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_multi',
            payment_intent: 'pi_multi',
            amount: 2000,
            amount_captured: 2000,
            // Two partial refunds: 25% + 25% = 50% total
            refunds: {
              data: [
                { id: 're_first', amount: 500 },
                { id: 're_second', amount: 500 },
              ],
            },
          },
        },
      };

      await invokeWebhookWithEvent(multiRefundEvent);

      expect(mockSubtractCredits).toHaveBeenCalledTimes(2);
      expect(mockSubtractCredits).toHaveBeenCalledWith(
        expect.objectContaining({ credits: 250, stripeRefundId: 're_first', reason: 'refund_clawback' }),
        expect.anything()
      );
      expect(mockSubtractCredits).toHaveBeenCalledWith(
        expect.objectContaining({ credits: 250, stripeRefundId: 're_second', reason: 'refund_clawback' }),
        expect.anything()
      );

      expect(mockClawbackCreditLotsByStripeRef).toHaveBeenCalledTimes(2);
      expect(mockClawbackCreditLotsByStripeRef).toHaveBeenCalledWith(
        'pi_multi',
        'proportional',
        250,
        expect.anything()
      );
    });

    it('skips already-processed refunds and continues to new ones (mixed idempotency)', async () => {
      const mockUser = { id: 'user123', name: 'Test', email: 'test@example.com' };
      const mockTx = { id: 'tx1', ownerId: 'user123', credits: 1000, stripePaymentIntentId: 'pi_idem' };

      mockFindByPaymentIntentId.mockResolvedValue(mockTx);
      mockFindById.mockResolvedValue(mockUser);
      // First refund already processed (11000), second is new
      mockSubtractCredits
        .mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }))
        .mockResolvedValueOnce({ currentCredits: 750 });

      const mixedEvent = {
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_mixed',
            payment_intent: 'pi_idem',
            amount: 2000,
            amount_captured: 2000,
            refunds: {
              data: [
                { id: 're_old', amount: 500 },
                { id: 're_new', amount: 500 },
              ],
            },
          },
        },
      };

      await expect(invokeWebhookWithEvent(mixedEvent)).resolves.not.toThrow();
      expect(mockSubtractCredits).toHaveBeenCalledTimes(2);
      expect(mockSubtractCredits).toHaveBeenCalledWith(
        expect.objectContaining({ stripeRefundId: 're_new' }),
        expect.anything()
      );
    });

    it('skips clawback when no original purchase found', async () => {
      mockFindByPaymentIntentId.mockResolvedValue(null);

      const refundEvent = {
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_no_tx',
            payment_intent: 'pi_none',
            amount: 1000,
            amount_captured: 1000,
            refunds: { data: [{ id: 're_noop', amount: 500 }] },
          },
        },
      };

      await invokeWebhookWithEvent(refundEvent);
      expect(mockSubtractCredits).not.toHaveBeenCalled();
      expect(mockClawbackCreditLotsByStripeRef).not.toHaveBeenCalled();
    });
  });

  describe('invoice.payment_failed', () => {
    it('sets subscription to past_due and invalidates client query cache', async () => {
      const invoiceFailedEvent = {
        type: 'invoice.payment_failed',
        data: {
          object: {
            id: 'in_fail',
            subscription: 'sub_123',
            parent: null,
            metadata: { userId: 'user_xyz' },
          },
        },
      };

      await invokeWebhookWithEvent(invoiceFailedEvent);

      expect(mockUpdateByStripeSubscriptionId).toHaveBeenCalledWith('sub_123', { status: 'past_due' });
      expect(mockSendToClient).toHaveBeenCalledWith(
        'user_xyz',
        expect.anything(),
        expect.objectContaining({ action: 'invalidate_query', queryKey: ['subscriptions'] })
      );
      expect(mockPostMessageToSlack).toHaveBeenCalledWith(expect.stringContaining('sub_123'));
    });

    it('skips when invoice has no subscription', async () => {
      const invoiceNoSubEvent = {
        type: 'invoice.payment_failed',
        data: {
          object: {
            id: 'in_nosub',
            subscription: null,
            parent: null,
            metadata: {},
          },
        },
      };

      await invokeWebhookWithEvent(invoiceNoSubEvent);
      expect(mockUpdateByStripeSubscriptionId).not.toHaveBeenCalled();
    });
  });

  describe('payment_intent.payment_failed', () => {
    it('marks transaction as failed when pre-allocated credits exist', async () => {
      const mockTx = { id: 'tx_fail', stripePaymentIntentId: 'pi_failed' };
      mockFindByPaymentIntentId.mockResolvedValue(mockTx);

      const intentFailedEvent = {
        type: 'payment_intent.payment_failed',
        data: { object: { id: 'pi_failed' } },
      };

      await invokeWebhookWithEvent(intentFailedEvent);

      expect(mockUpdateTransactionStatus).toHaveBeenCalledWith('pi_failed', CreditPurchaseStatus.Failed);
    });

    it('is a no-op when no pre-allocated credits exist', async () => {
      mockFindByPaymentIntentId.mockResolvedValue(null);

      const intentFailedEvent = {
        type: 'payment_intent.payment_failed',
        data: { object: { id: 'pi_noop' } },
      };

      await invokeWebhookWithEvent(intentFailedEvent);
      expect(mockUpdateTransactionStatus).not.toHaveBeenCalled();
    });
  });
});
