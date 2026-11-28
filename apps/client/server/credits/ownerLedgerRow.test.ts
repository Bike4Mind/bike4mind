import { describe, it, expect } from 'vitest';
import type { ICreditTransactionDocument } from '@bike4mind/common';
import { toOwnerLedgerRow } from './ownerLedgerRow';

const base = { id: 'tx-1', ownerId: 'u1', ownerType: 'User', createdAt: new Date(), updatedAt: new Date() };

describe('toOwnerLedgerRow', () => {
  it('drops referral reward metadata ids while keeping the displayed fields', () => {
    const out = toOwnerLedgerRow({
      ...base,
      type: 'generic_add',
      reason: 'referral_reward',
      credits: 500,
      transactionId: 'referral-subscription:inviter:in_1',
      metadata: { step: 'subscription', referredUserId: 'friend-1', invoiceId: 'in_1' },
    } as unknown as ICreditTransactionDocument);

    expect(out).toMatchObject({ id: 'tx-1', type: 'generic_add', reason: 'referral_reward', credits: 500 });
    expect(out).not.toHaveProperty('metadata');
    expect(out).not.toHaveProperty('ownerId');
    expect(out).not.toHaveProperty('transactionId');
    expect(JSON.stringify(out)).not.toContain('friend-1');
    expect(JSON.stringify(out)).not.toContain('in_1');
  });

  it('keeps only metadata.modelName on usage rows and drops payment and session ids', () => {
    const out = toOwnerLedgerRow({
      ...base,
      type: 'text_generation_usage',
      credits: -3,
      model: 'claude-x',
      sessionId: 's1',
      questId: 'q1',
      apiKeyId: 'k1',
      oauthClientId: 'c1',
      metadata: { modelName: 'Claude X', actingUserId: 'u2' },
    } as unknown as ICreditTransactionDocument);

    expect(out).toMatchObject({ model: 'claude-x', metadata: { modelName: 'Claude X' } });
    for (const key of ['sessionId', 'questId', 'apiKeyId', 'oauthClientId']) expect(out).not.toHaveProperty(key);
  });

  it('keeps purchase amount and status but not the payment intent id', () => {
    const out = toOwnerLedgerRow({
      ...base,
      type: 'purchase',
      credits: 1000,
      amount: 1000,
      status: 'completed',
      stripePaymentIntentId: 'pi_1',
    } as unknown as ICreditTransactionDocument);
    expect(out).toMatchObject({ amount: 1000, status: 'completed' });
    expect(out).not.toHaveProperty('stripePaymentIntentId');
  });

  it('reads the fields of a hydrated document through toJSON', () => {
    const data = { ...base, type: 'subscription', credits: 200, ownerId: 'u1', stripePaymentIntentId: 'pi_2' };
    const hydrated = { $__: {}, _doc: data, toJSON: () => data } as unknown as ICreditTransactionDocument;

    const out = toOwnerLedgerRow(hydrated);

    expect(out).toMatchObject({ id: 'tx-1', type: 'subscription', credits: 200 });
    expect(out).not.toHaveProperty('$__');
    expect(out).not.toHaveProperty('stripePaymentIntentId');
  });
});
