import { describe, it, expect } from 'vitest';
import { setupMongoTest } from '../../__test__/utils';
import { PaymentRiskActionModel, paymentRiskActionRepository } from './PaymentRiskActionModel';

describe('PaymentRiskActionModel', () => {
  setupMongoTest();

  it('lets exactly one caller claim a step', async () => {
    await PaymentRiskActionModel.createIndexes();

    await expect(paymentRiskActionRepository.claimStep('efw:1', 'alert', 'u1')).resolves.toBe(true);
    await expect(paymentRiskActionRepository.claimStep('efw:1', 'alert', 'u1')).resolves.toBe(false);
    await expect(paymentRiskActionRepository.claimStep('efw:1', 'signupClawback', 'u1')).resolves.toBe(true);

    const doc = await PaymentRiskActionModel.findOne({ key: 'efw:1' }).lean();
    expect(doc?.steps).toEqual(['alert', 'signupClawback']);
    expect(doc?.userId).toBe('u1');
  });

  it('claims different steps of a new key concurrently, and one step only once', async () => {
    await PaymentRiskActionModel.createIndexes();

    const results = await Promise.all([
      paymentRiskActionRepository.claimStep('efw:2', 'alert', 'u1'),
      paymentRiskActionRepository.claimStep('efw:2', 'signupClawback', 'u1'),
      paymentRiskActionRepository.claimStep('efw:2', 'alert', 'u1'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(2);
    const doc = await PaymentRiskActionModel.findOne({ key: 'efw:2' }).lean();
    expect([...(doc?.steps ?? [])].sort()).toEqual(['alert', 'signupClawback']);
  });

  it('reports a key completed only once marked', async () => {
    await PaymentRiskActionModel.createIndexes();
    await paymentRiskActionRepository.claimStep('efw:3', 'alert', 'u1');

    await expect(paymentRiskActionRepository.isCompleted('efw:3')).resolves.toBe(false);
    await paymentRiskActionRepository.markCompleted('efw:3', 'u1');
    await expect(paymentRiskActionRepository.isCompleted('efw:3')).resolves.toBe(true);
    await expect(paymentRiskActionRepository.isCompleted('efw:missing')).resolves.toBe(false);
  });
});
