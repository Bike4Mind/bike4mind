import { describe, it, expect, vi, beforeEach } from 'vitest';
import Stripe from 'stripe';
import { subscriptionRepository } from '@server/models/Subscription';
import { organizationRepository, userRepository } from '@bike4mind/database';
import { creditService } from '@bike4mind/services';
import { emitMetric } from '@server/utils/cloudwatch';
import { handleOrganizationSubscriptionInvoice, handleUserSubscriptionInvoice } from './serverUtils';
import { SubscriptionOwnerType, SubscriptionSource } from '@client/lib/subscriptions/types';
import type { Logger } from '@bike4mind/observability';

// Vitest hoists these mocks above the imports.
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    findByStripeSubscriptionId: vi.fn(),
    findActiveSubscriptionsByOwner: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    flipAdminGrantToStripe: vi.fn(),
  },
  Subscription: {},
}));

vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  return {
    ...actual,
    userRepository: {
      findById: vi.fn().mockResolvedValue({ id: 'u1', email: 'owner@acme.com' }),
      findByStripeCustomerId: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
    },
    organizationRepository: {
      findById: vi.fn(),
      findByStripeCustomerId: vi.fn(),
    },
    creditTransactionRepository: { findByPaymentIntentId: vi.fn().mockResolvedValue(null) },
    withTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('@bike4mind/services', () => ({
  creditService: { addCredits: vi.fn().mockResolvedValue(undefined) },
  organizationService: { create: vi.fn() },
}));

vi.mock('@server/websocket/utils', () => ({
  sendToClient: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@server/utils/cloudwatch', () => ({
  emitMetric: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('sst', () => ({
  // vitest mock stub, not a real WebSocket connection.
  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
  Resource: { websocket: { managementEndpoint: 'ws://test' } },
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const buildInvoice = (): Stripe.Invoice =>
  ({
    id: 'in_test',
    customer: 'cus_test',
    billing_reason: 'subscription_create',
    created: 1700000000,
    lines: { data: [{ quantity: 4 }] },
    payments: { data: [] },
  }) as unknown as Stripe.Invoice;

const buildSubscription = (): Stripe.Subscription =>
  ({
    id: 'sub_stripe_xyz',
    status: 'active',
    items: {
      data: [
        {
          quantity: 4,
          price: { id: 'price_org' },
          current_period_start: 1700000000,
          current_period_end: 1702592000,
        },
      ],
    },
  }) as unknown as Stripe.Subscription;

describe('handleOrganizationSubscriptionInvoice — conversion flip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (subscriptionRepository.findByStripeSubscriptionId as any).mockResolvedValue(null);
  });

  it('atomically flips an existing admin_grant Subscription in place instead of creating a new one', async () => {
    (organizationRepository.findById as any).mockResolvedValue({
      id: 'org1',
      name: 'Acme',
      users: [],
    });
    (subscriptionRepository.findActiveSubscriptionsByOwner as any).mockResolvedValue([
      {
        id: 'subDoc_admin_grant',
        source: SubscriptionSource.AdminGrant,
        subscriptionId: undefined,
        ownerType: SubscriptionOwnerType.Organization,
        ownerId: 'org1',
      },
    ]);
    (subscriptionRepository.flipAdminGrantToStripe as any).mockResolvedValue({
      id: 'subDoc_admin_grant',
      source: SubscriptionSource.Stripe,
      subscriptionId: 'sub_stripe_xyz',
    });

    await handleOrganizationSubscriptionInvoice(
      buildInvoice(),
      buildSubscription(),
      {
        userId: 'u1',
        stage: 'test',
        ownerType: SubscriptionOwnerType.Organization,
        organizationId: 'org1',
      } as any,
      logger
    );

    expect(subscriptionRepository.flipAdminGrantToStripe).toHaveBeenCalledWith(
      'subDoc_admin_grant',
      expect.objectContaining({
        source: SubscriptionSource.Stripe,
        subscriptionId: 'sub_stripe_xyz',
        priceId: 'price_org',
        status: 'active',
        quantity: 4,
      })
    );
    expect(subscriptionRepository.create).not.toHaveBeenCalled();
  });

  it('skips when a concurrent writer already won the admin_grant flip race', async () => {
    // Two webhook deliveries can arrive in parallel for the same conversion.
    // The first wins flipAdminGrantToStripe (returns the updated doc); the
    // second sees null (filter no longer matches) and must NOT grant credits
    // again or create a duplicate row.
    (organizationRepository.findById as any).mockResolvedValue({ id: 'org_race', name: 'R', users: [] });
    (subscriptionRepository.findActiveSubscriptionsByOwner as any).mockResolvedValue([
      {
        id: 'doc_race',
        source: SubscriptionSource.AdminGrant,
        ownerType: SubscriptionOwnerType.Organization,
        ownerId: 'org_race',
      },
    ]);
    (subscriptionRepository.flipAdminGrantToStripe as any).mockResolvedValue(null);

    await handleOrganizationSubscriptionInvoice(
      buildInvoice(),
      buildSubscription(),
      { userId: 'u1', stage: 'test', ownerType: SubscriptionOwnerType.Organization, organizationId: 'org_race' } as any,
      logger
    );

    expect(subscriptionRepository.create).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('already flipped by a concurrent writer'));
  });

  it('creates a fresh Subscription when no admin_grant exists for the org', async () => {
    (organizationRepository.findById as any).mockResolvedValue({
      id: 'org2',
      name: 'Beta',
      users: [],
    });
    (subscriptionRepository.findActiveSubscriptionsByOwner as any).mockResolvedValue([]);

    await handleOrganizationSubscriptionInvoice(
      buildInvoice(),
      buildSubscription(),
      {
        userId: 'u1',
        stage: 'test',
        ownerType: SubscriptionOwnerType.Organization,
        organizationId: 'org2',
      } as any,
      logger
    );

    expect(subscriptionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerType: SubscriptionOwnerType.Organization,
        ownerId: 'org2',
        subscriptionId: 'sub_stripe_xyz',
        source: SubscriptionSource.Stripe,
        quantity: 4,
      })
    );
    expect(subscriptionRepository.update).not.toHaveBeenCalled();
  });

  it('refuses to create a duplicate Stripe Subscription if one already exists for the org', async () => {
    // Simulates a double-Convert-to-paid race: the first checkout already
    // flipped the admin_grant to source=stripe; a second checkout completes
    // and arrives at the webhook. We must NOT create a second active row,
    // because the customer would then be billed for both subscriptions.
    (organizationRepository.findById as any).mockResolvedValue({
      id: 'org3',
      name: 'Gamma',
      users: [],
    });
    (subscriptionRepository.findActiveSubscriptionsByOwner as any).mockResolvedValue([
      {
        id: 'subDoc_existing_stripe',
        source: SubscriptionSource.Stripe,
        subscriptionId: 'sub_stripe_first',
        ownerType: SubscriptionOwnerType.Organization,
        ownerId: 'org3',
      },
    ]);

    await handleOrganizationSubscriptionInvoice(
      buildInvoice(),
      buildSubscription(),
      {
        userId: 'u1',
        stage: 'test',
        ownerType: SubscriptionOwnerType.Organization,
        organizationId: 'org3',
      } as any,
      logger
    );

    expect(subscriptionRepository.create).not.toHaveBeenCalled();
    expect(subscriptionRepository.flipAdminGrantToStripe).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('already has an active Stripe subscription'));
  });
});

describe('handleUserSubscriptionInvoice — plan lookup', () => {
  const metadata = {
    userId: 'u1',
    stage: 'test',
    ownerType: SubscriptionOwnerType.User,
  } as any;

  const buildUserSubscription = (priceId: string): Stripe.Subscription =>
    ({
      id: 'sub_user_xyz',
      status: 'active',
      items: {
        data: [
          {
            price: { id: priceId },
            current_period_start: 1700000000,
            current_period_end: 1702592000,
          },
        ],
      },
    }) as unknown as Stripe.Subscription;

  beforeEach(() => {
    vi.clearAllMocks();
    (userRepository.findByStripeCustomerId as any).mockResolvedValue({ id: 'u1', email: 'owner@acme.com' });
    (subscriptionRepository.findByStripeSubscriptionId as any).mockResolvedValue(null);
  });

  it('errors loudly and emits EntitlementSkipped when the price matches no plan — never a silent no-op', async () => {
    // Exact failure mode: with the NEXT_PUBLIC_STRIPE_PRICE_* env vars absent from the
    // Lambda env, every configured priceId is '' and no plan matches.
    await handleUserSubscriptionInvoice(buildInvoice(), buildUserSubscription('price_unknown_xyz'), metadata, logger);

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('price_unknown_xyz'));
    expect(emitMetric).toHaveBeenCalledWith('Lumina5/Entitlements', 'EntitlementSkipped', 1, {
      reason: 'unknown_plan',
    });
    expect(subscriptionRepository.create).not.toHaveBeenCalled();
    expect(creditService.addCredits).not.toHaveBeenCalled();
  });

  it('creates the subscription and grants plan credits when the price matches a configured plan', async () => {
    // 'price_test_professional' comes from vitest.setup.ts (NEXT_PUBLIC_STRIPE_PRICE_PRO_TEST),
    // mirroring the price env vars now injected into the Lambda env via
    // DEFAULT_LAMBDA_ENVIRONMENT (infra/constants.ts).
    await handleUserSubscriptionInvoice(
      buildInvoice(),
      buildUserSubscription('price_test_professional'),
      metadata,
      logger
    );

    expect(subscriptionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerType: SubscriptionOwnerType.User,
        ownerId: 'u1',
        subscriptionId: 'sub_user_xyz',
        priceId: 'price_test_professional',
        source: SubscriptionSource.Stripe,
      })
    );
    expect(creditService.addCredits).toHaveBeenCalledWith(
      expect.objectContaining({ credits: 31667, type: 'subscription' }),
      expect.anything()
    );
    expect(emitMetric).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
