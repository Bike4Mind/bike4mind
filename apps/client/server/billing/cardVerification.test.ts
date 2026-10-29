import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { CardVerificationRecord } from './cardVerificationModel';

const state = vi.hoisted(() => ({ record: null as CardVerificationRecord | null }));
vi.mock('./cardVerificationModel', () => ({
  CardVerification: {
    create: vi.fn(async (record: CardVerificationRecord) => {
      state.record = { ...record, createdAt: new Date() };
    }),
    findOne: vi.fn((filter: Partial<CardVerificationRecord>) => ({
      lean: async () =>
        state.record &&
        Object.entries(filter).every(([key, value]) => state.record?.[key as keyof CardVerificationRecord] === value)
          ? { ...state.record }
          : null,
    })),
    updateOne: vi.fn(
      async (
        filter: Partial<CardVerificationRecord>,
        update: {
          $set?: Partial<CardVerificationRecord>;
          $unset?: Partial<Record<keyof CardVerificationRecord, number>>;
        }
      ) => {
        if (
          !state.record ||
          !Object.entries(filter).every(([key, value]) => state.record?.[key as keyof CardVerificationRecord] === value)
        )
          return;
        Object.assign(state.record, update.$set);
        for (const key of Object.keys(update.$unset ?? {})) delete state.record[key as keyof CardVerificationRecord];
      }
    ),
  },
}));
vi.mock('./grantVerifiedCardCredits', () => ({ grantVerifiedCardCredits: vi.fn() }));

import { CardVerification } from './cardVerificationModel';
import { grantVerifiedCardCredits } from './grantVerifiedCardCredits';
import {
  beginCardVerification,
  completeCardVerification,
  removeVerificationCard,
  resumeCardVerificationSetup,
  type CardVerificationDependencies,
} from './cardVerificationLifecycle';

function fixture() {
  const policy = {
    enabled: true,
    cardUnlockCredits: 17,
    identityKey: 'synthetic-key-'.repeat(4),
    environment: 'test',
    livemode: false,
  };
  const record: CardVerificationRecord = {
    verificationId: 'synthetic-verification',
    userId: 'synthetic-user',
    environment: 'test',
    livemode: false,
    customerId: 'cus_synthetic',
    setupIntentId: 'seti_synthetic',
    credits: 17,
    saveCard: false,
    state: 'pending',
    detached: false,
    createdAt: new Date(),
  };
  const customer = {
    id: record.customerId,
    livemode: false,
    metadata: { purpose: 'card_verification', verificationId: record.verificationId, environment: 'test' },
    invoice_settings: { default_payment_method: null },
    default_source: null,
  };
  const intent = {
    id: record.setupIntentId,
    customer: record.customerId,
    livemode: false,
    status: 'succeeded',
    usage: 'on_session',
    payment_method_types: ['card'],
    metadata: customer.metadata,
    payment_method: 'pm_synthetic',
    last_setup_error: null,
    client_secret: 'synthetic-secret',
  };
  const method = {
    id: 'pm_synthetic',
    customer: record.customerId,
    livemode: false,
    type: 'card',
    card: { fingerprint: 'synthetic-fingerprint', funding: 'credit', wallet: null as object | null },
  };
  const stripe = {
    customers: { create: vi.fn(async () => customer), retrieve: vi.fn(async () => customer) },
    setupIntents: { create: vi.fn(async () => intent), retrieve: vi.fn(async () => intent) },
    paymentMethods: {
      retrieve: vi.fn(async () => method),
      detach: vi.fn(async () => {
        method.customer = null as unknown as string;
      }),
    },
    subscriptions: { list: vi.fn(() => (async function* () {})()) },
  };
  const guards = {
    authorizeAttempt: vi.fn(async () => {}),
    approveRisk: vi.fn(async () => true),
    recordFailure: vi.fn(async () => {}),
    eligible: vi.fn(async () => true),
  };
  const deps: CardVerificationDependencies = {
    stripe: stripe as unknown as Stripe,
    policy: async () => policy,
    guards,
  };
  state.record = record;
  return { policy, record, customer, intent, method, stripe, guards, deps };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.record = null;
  vi.mocked(grantVerifiedCardCredits).mockResolvedValue('granted');
});

describe('no-charge verification lifecycle', () => {
  it('requires configured guards before any provider call', async () => {
    const f = fixture();
    f.deps.guards = undefined;
    await expect(
      beginCardVerification(
        { userId: 'u', ip: 'synthetic-ip', asn: 'synthetic-asn', turnstileToken: '' },
        false,
        f.deps
      )
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.stripe.customers.create).not.toHaveBeenCalled();
    expect(CardVerification.create).not.toHaveBeenCalled();
  });

  it('refuses disabled or malformed policy before provider access', async () => {
    const f = fixture();
    f.policy.enabled = false;
    await expect(completeCardVerification(f.record.verificationId, f.record.userId, f.deps)).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(f.stripe.setupIntents.retrieve).not.toHaveBeenCalled();
  });

  it('enforces challenge and limits before creating a setup', async () => {
    const f = fixture();
    f.guards.authorizeAttempt.mockRejectedValue(new Error('synthetic lockout'));
    await expect(
      beginCardVerification({ userId: 'u', ip: 'ip', asn: 'asn', turnstileToken: 'token' }, false, f.deps)
    ).rejects.toThrow('synthetic lockout');
    expect(f.stripe.customers.create).not.toHaveBeenCalled();
    expect(CardVerification.create).not.toHaveBeenCalled();
  });

  it('creates only an on-session card setup, snapshots the amount and explicit consent', async () => {
    const f = fixture();
    f.stripe.customers.create.mockImplementation(async () => ({
      ...f.customer,
      metadata: {
        ...f.customer.metadata,
        verificationId: state.record!.verificationId,
      },
    }));
    f.stripe.setupIntents.create.mockImplementation(async () => ({
      ...f.intent,
      metadata: { ...f.intent.metadata, verificationId: state.record!.verificationId },
    }));
    await beginCardVerification({ userId: 'u', ip: 'ip', asn: 'asn', turnstileToken: 'token' }, false, f.deps);
    expect(CardVerification.create).toHaveBeenCalledWith(expect.objectContaining({ credits: 17, saveCard: false }));
    expect(f.stripe.setupIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ usage: 'on_session', payment_method_types: ['card'] }),
      expect.objectContaining({ idempotencyKey: expect.any(String) })
    );
    expect(f.stripe.setupIntents.create.mock.calls[0][0]).not.toHaveProperty('amount');
  });

  it('resumes a setup without recreating persisted Stripe objects', async () => {
    const f = fixture();
    await resumeCardVerificationSetup(f.record.verificationId, f.record.userId, f.deps);
    expect(f.stripe.customers.create).not.toHaveBeenCalled();
    expect(f.stripe.setupIntents.create).not.toHaveBeenCalled();
  });

  it('does not recreate an old setup after provider idempotency expires', async () => {
    const f = fixture();
    f.record.createdAt = new Date(0);
    await expect(resumeCardVerificationSetup(f.record.verificationId, f.record.userId, f.deps)).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(f.stripe.customers.create).not.toHaveBeenCalled();
    expect(f.stripe.setupIntents.create).not.toHaveBeenCalled();
  });

  it('does not return a client secret for a customer or setup with mismatched ownership', async () => {
    const f = fixture();
    f.intent.customer = 'cus_other';
    await expect(resumeCardVerificationSetup(f.record.verificationId, f.record.userId, f.deps)).rejects.toMatchObject({
      code: 'not_found',
    });
    f.intent.customer = f.record.customerId;
    f.customer.metadata.verificationId = 'other-verification';
    await expect(resumeCardVerificationSetup(f.record.verificationId, f.record.userId, f.deps)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('does not grant on a risk outage and still detaches by default', async () => {
    const f = fixture();
    f.guards.approveRisk.mockRejectedValue(new Error('synthetic risk outage'));
    await expect(completeCardVerification(f.record.verificationId, f.record.userId, f.deps)).rejects.toThrow(
      'synthetic risk outage'
    );
    expect(grantVerifiedCardCredits).not.toHaveBeenCalled();
    expect(f.stripe.paymentMethods.detach).toHaveBeenCalledTimes(1);
    expect(state.record?.state).toBe('refused');
    expect(await completeCardVerification(f.record.verificationId, f.record.userId, f.deps)).toBe('refused');
  });

  it('validates ownership without disclosing or detaching another account card', async () => {
    const f = fixture();
    await expect(completeCardVerification(f.record.verificationId, 'other-user', f.deps)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(removeVerificationCard(f.record.verificationId, 'other-user', f.deps)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(f.stripe.setupIntents.retrieve).not.toHaveBeenCalled();
    expect(f.stripe.paymentMethods.detach).not.toHaveBeenCalled();
  });

  it.each(['customer', 'livemode', 'environment', 'status'] as const)('does not grant with invalid %s', async field => {
    const f = fixture();
    if (field === 'customer') f.intent.customer = 'cus_other';
    if (field === 'livemode') f.intent.livemode = true;
    if (field === 'environment') f.intent.metadata.environment = 'other';
    if (field === 'status') f.intent.status = 'processing';
    if (field === 'status')
      expect(await completeCardVerification(f.record.verificationId, f.record.userId, f.deps)).toBe('pending');
    else
      await expect(completeCardVerification(f.record.verificationId, f.record.userId, f.deps)).rejects.toMatchObject({
        code: 'not_found',
      });
    expect(grantVerifiedCardCredits).not.toHaveBeenCalled();
  });

  it.each(['prepaid', 'unknown', 'wallet', 'missing_fingerprint', 'risk'] as const)(
    'refuses %s and detaches',
    async reason => {
      const f = fixture();
      if (reason === 'prepaid' || reason === 'unknown') f.method.card.funding = reason;
      if (reason === 'wallet') f.method.card.wallet = { type: 'apple_pay' };
      if (reason === 'missing_fingerprint') f.method.card.fingerprint = '';
      if (reason === 'risk') f.guards.approveRisk.mockResolvedValue(false);
      await expect(completeCardVerification(f.record.verificationId, f.record.userId, f.deps)).rejects.toMatchObject({
        code: reason === 'risk' ? 'risk_refused' : 'unsupported_card',
      });
      expect(grantVerifiedCardCredits).not.toHaveBeenCalled();
      expect(f.stripe.paymentMethods.detach).toHaveBeenCalledWith('pm_synthetic');
      expect(state.record?.state).toBe('refused');
    }
  );

  it('persists only a keyed digest and defaults to detach after grant', async () => {
    const f = fixture();
    expect(await completeCardVerification(f.record.verificationId, f.record.userId, f.deps)).toBe('granted');
    expect(state.record?.identityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(state.record)).not.toContain('synthetic-fingerprint');
    expect(state.record?.detached).toBe(true);
    expect(state.record?.paymentMethodId).toBeUndefined();
  });

  it('recovers posting failure after detaching without needing provider evidence again', async () => {
    const f = fixture();
    vi.mocked(grantVerifiedCardCredits).mockRejectedValueOnce(new Error('synthetic balance failure'));
    await expect(completeCardVerification(f.record.verificationId, f.record.userId, f.deps)).rejects.toThrow(
      'synthetic balance failure'
    );
    expect(state.record?.state).toBe('verified');
    expect(state.record?.detached).toBe(true);
    expect(await completeCardVerification(f.record.verificationId, f.record.userId, f.deps)).toBe('granted');
    expect(f.stripe.setupIntents.retrieve).toHaveBeenCalledTimes(1);
  });

  it('recovers a detach failure on replay', async () => {
    const f = fixture();
    f.stripe.paymentMethods.detach.mockRejectedValueOnce(new Error('synthetic detach failure'));
    await expect(completeCardVerification(f.record.verificationId, f.record.userId, f.deps)).rejects.toThrow(
      'synthetic detach failure'
    );
    expect(await completeCardVerification(f.record.verificationId, f.record.userId, f.deps)).toBe('granted');
    expect(state.record?.detached).toBe(true);
  });

  it('keeps a card only with explicit consent and supports removal afterward', async () => {
    const f = fixture();
    f.record.saveCard = true;
    await completeCardVerification(f.record.verificationId, f.record.userId, f.deps);
    expect(f.stripe.paymentMethods.detach).not.toHaveBeenCalled();
    await removeVerificationCard(f.record.verificationId, f.record.userId, f.deps);
    expect(f.stripe.paymentMethods.detach).toHaveBeenCalledTimes(1);
  });

  it('refuses to detach a subscription customer even if a method belongs to it', async () => {
    const f = fixture();
    f.record.paymentMethodId = f.method.id;
    f.stripe.subscriptions.list.mockImplementation(
      () =>
        (async function* () {
          yield { status: 'past_due' };
        })() as ReturnType<typeof f.stripe.subscriptions.list>
    );
    await expect(removeVerificationCard(f.record.verificationId, f.record.userId, f.deps)).rejects.toMatchObject({
      code: 'ineligible',
    });
    expect(f.stripe.paymentMethods.detach).not.toHaveBeenCalled();
  });
});
