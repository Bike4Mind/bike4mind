import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  forfeitPaymentUnlock: vi.fn(),
  findByStripeCustomerId: vi.fn(),
  findByPaymentIntentId: vi.fn(),
  findById: vi.fn(),
  recordPaymentRiskEvent: vi.fn(),
  findPaymentUserId: vi.fn(),
  findOrganizationByStripeCustomerId: vi.fn(),
  retrieveCharge: vi.fn(),
  alertFraudBlock: vi.fn(),
  reopenSettledPaymentApproval: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  creditLotRepository: {},
  creditTransactionRepository: { findByPaymentIntentId: mocks.findByPaymentIntentId },
  organizationRepository: { findByStripeCustomerId: mocks.findOrganizationByStripeCustomerId },
  paymentAttemptRepository: { findUserId: mocks.findPaymentUserId },
  userRepository: {
    findByStripeCustomerId: mocks.findByStripeCustomerId,
    findById: mocks.findById,
    recordPaymentRiskEvent: mocks.recordPaymentRiskEvent,
  },
}));
vi.mock('@bike4mind/services', () => ({ userService: { forfeitPaymentUnlock: mocks.forfeitPaymentUnlock } }));
vi.mock('@bike4mind/server-utils/auth/signupProtection', () => ({ signupProtection: {} }));
vi.mock('@server/billing/fraudBlockAlert', () => ({ alertFraudBlock: mocks.alertFraudBlock }));
vi.mock('@server/security/riskReviewAutoApproval', () => ({
  reopenSettledPaymentApproval: mocks.reopenSettledPaymentApproval,
}));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  stripe: { charges: { retrieve: mocks.retrieveCharge } },
}));
import { forfeitHeldUnlockForFraudWarning, forfeitHeldUnlockForRefund } from './paymentUnlockForfeit';

const logger = { info: vi.fn(), warn: vi.fn() };
const forfeitedWith = () => mocks.forfeitPaymentUnlock.mock.calls.map(([userId, cause]) => [userId, cause]);

describe('payment unlock forfeit helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.forfeitPaymentUnlock.mockResolvedValue({ outcome: 'cancelled' });
    mocks.reopenSettledPaymentApproval.mockResolvedValue(false);
    mocks.findByStripeCustomerId.mockImplementation(async id => (id === 'cus_1' ? { id: 'user_1' } : null));
    mocks.findPaymentUserId.mockResolvedValue(null);
    mocks.findOrganizationByStripeCustomerId.mockImplementation(async id =>
      id === 'cus_org' ? { id: 'org_1' } : null
    );
    mocks.findById.mockImplementation(async id => (id === 'user_2' ? { id: 'user_2' } : null));
  });

  it('forfeits for the refunded charge payer, by customer id or expanded customer', async () => {
    await forfeitHeldUnlockForRefund({ customer: 'cus_1' }, logger);
    await forfeitHeldUnlockForRefund({ customer: { id: 'cus_1' } }, logger);
    await forfeitHeldUnlockForRefund({ customer: 'cus_org' }, logger);
    await forfeitHeldUnlockForRefund({ customer: null }, logger);
    expect(forfeitedWith()).toEqual([
      ['user_1', 'refund'],
      ['user_1', 'refund'],
    ]);
    expect(logger.info).toHaveBeenCalledWith('Held signup unlock bonus cancelled after a payment refund', {
      userId: 'user_1',
    });
  });

  it('falls back to the credit pack buyer when the refunded charge has no customer user', async () => {
    mocks.findByPaymentIntentId.mockImplementation(async id =>
      id === 'pi_pack'
        ? { ownerType: 'User', ownerId: 'user_2' }
        : id === 'pi_org'
          ? { ownerType: 'Organization', ownerId: 'org_1' }
          : null
    );
    await forfeitHeldUnlockForRefund({ customer: null, payment_intent: 'pi_pack' }, logger);
    await forfeitHeldUnlockForRefund({ customer: 'cus_gone', payment_intent: { id: 'pi_pack' } }, logger);
    await forfeitHeldUnlockForRefund({ customer: null, payment_intent: 'pi_org' }, logger);
    await forfeitHeldUnlockForRefund({ customer: null, payment_intent: 'pi_none' }, logger);
    await forfeitHeldUnlockForRefund({ customer: 'cus_1', payment_intent: 'pi_pack' }, logger);
    expect(forfeitedWith()).toEqual([
      ['user_2', 'refund'],
      ['user_2', 'refund'],
      ['user_1', 'refund'],
    ]);
  });

  it('resolves the warned charge payer, and warns when there is none', async () => {
    mocks.retrieveCharge.mockResolvedValueOnce({ customer: 'cus_1' }).mockResolvedValueOnce({ customer: 'cus_x' });
    await forfeitHeldUnlockForFraudWarning({ id: 'issfr_1', charge: 'ch_1' }, logger);
    await forfeitHeldUnlockForFraudWarning({ id: 'issfr_2', charge: { id: 'ch_2' } }, logger);
    expect(mocks.retrieveCharge.mock.calls).toEqual([['ch_1'], ['ch_2']]);
    expect(forfeitedWith()).toEqual([['user_1', 'fraud_warning']]);
    expect(logger.warn).toHaveBeenCalledWith('Could not find user for early fraud warning issfr_2');
  });

  it('falls back to the credit pack buyer when the warned charge has no customer user', async () => {
    mocks.findByPaymentIntentId.mockImplementation(async id =>
      id === 'pi_pack' ? { ownerType: 'User', ownerId: 'user_2' } : null
    );
    mocks.retrieveCharge
      .mockResolvedValueOnce({ customer: null, payment_intent: 'pi_pack' })
      .mockResolvedValueOnce({ customer: null, payment_intent: 'pi_none' });
    await forfeitHeldUnlockForFraudWarning({ id: 'issfr_3', charge: 'ch_3' }, logger);
    await forfeitHeldUnlockForFraudWarning({ id: 'issfr_4', charge: 'ch_4' }, logger);
    expect(forfeitedWith()).toEqual([['user_2', 'fraud_warning']]);
    expect(logger.warn).toHaveBeenCalledWith('Could not find user for early fraud warning issfr_4');
  });

  it('alerts LiveOps when a held unlock is actually cancelled, not on a replay', async () => {
    await forfeitHeldUnlockForRefund({ customer: 'cus_1' }, logger);
    mocks.forfeitPaymentUnlock.mockResolvedValueOnce({ outcome: 'already_forfeited' });
    await forfeitHeldUnlockForRefund({ customer: 'cus_1' }, logger);
    expect(mocks.alertFraudBlock).toHaveBeenCalledExactlyOnceWith({
      kind: 'signupUnlockForfeited',
      userId: 'user_1',
      details: ['*Cause:* payment refund'],
    });
  });

  it('reopens a settled-payment risk review approval for the same payer and cause, even with no unlock held', async () => {
    mocks.forfeitPaymentUnlock.mockResolvedValue({ outcome: 'not_enrolled' });
    mocks.reopenSettledPaymentApproval.mockResolvedValue(true);
    await forfeitHeldUnlockForRefund({ customer: 'cus_1' }, logger);
    expect(mocks.reopenSettledPaymentApproval).toHaveBeenCalledExactlyOnceWith('user_1', 'refund');
    expect(logger.info).toHaveBeenCalledWith('Settled-payment risk review approval reopened after a payment refund', {
      userId: 'user_1',
    });
  });

  it('records the payment risk event before the reopen, even for an account with no signup grant', async () => {
    mocks.forfeitPaymentUnlock.mockResolvedValue({ outcome: 'not_enrolled' });
    await forfeitHeldUnlockForRefund({ customer: 'cus_1' }, logger);
    expect(mocks.recordPaymentRiskEvent).toHaveBeenCalledExactlyOnceWith('user_1', expect.any(Date));
    expect(mocks.recordPaymentRiskEvent.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.reopenSettledPaymentApproval.mock.invocationCallOrder[0]
    );
  });

  it('falls back to the payment intent payer when the customer resolves to nobody', async () => {
    mocks.findPaymentUserId.mockImplementation(async id => (id === 'pi_2' ? 'user_2' : null));
    await forfeitHeldUnlockForRefund({ customer: 'cus_detached', payment_intent: 'pi_2' }, logger);
    await forfeitHeldUnlockForRefund({ customer: null, payment_intent: { id: 'pi_2' } }, logger);
    await forfeitHeldUnlockForRefund({ customer: null, payment_intent: 'pi_unknown' }, logger);
    await forfeitHeldUnlockForRefund({ customer: 'cus_1', payment_intent: 'pi_2' }, logger);
    expect(forfeitedWith()).toEqual([
      ['user_2', 'refund'],
      ['user_2', 'refund'],
      ['user_1', 'refund'],
    ]);
    expect(mocks.findPaymentUserId.mock.calls).toEqual([['pi_2'], ['pi_2'], ['pi_unknown']]);
  });

  it('never attributes an organization charge to the member who started it', async () => {
    mocks.findPaymentUserId.mockResolvedValue('user_2');
    await forfeitHeldUnlockForRefund({ customer: 'cus_org', payment_intent: 'pi_2' }, logger);
    expect(forfeitedWith()).toEqual([]);
    expect(mocks.recordPaymentRiskEvent).not.toHaveBeenCalled();
  });

  it('falls back to the warned charge payment intent payer', async () => {
    mocks.retrieveCharge.mockResolvedValueOnce({ customer: null, payment_intent: 'pi_2' });
    mocks.findPaymentUserId.mockResolvedValueOnce('user_2');
    await forfeitHeldUnlockForFraudWarning({ id: 'issfr_1', charge: 'ch_1' }, logger);
    expect(forfeitedWith()).toEqual([['user_2', 'fraud_warning']]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('propagates a failed reopen so the webhook is retried', async () => {
    mocks.reopenSettledPaymentApproval.mockRejectedValueOnce(new Error('audit down'));
    await expect(forfeitHeldUnlockForRefund({ customer: 'cus_1' }, logger)).rejects.toThrow('audit down');
  });

  it('propagates a failed forfeit so the webhook is retried', async () => {
    mocks.forfeitPaymentUnlock.mockRejectedValueOnce(new Error('write failed'));
    await expect(forfeitHeldUnlockForRefund({ customer: 'cus_1' }, logger)).rejects.toThrow('write failed');
  });
});
