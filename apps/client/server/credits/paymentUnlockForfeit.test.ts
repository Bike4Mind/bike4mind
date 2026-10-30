import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  forfeitPaymentUnlock: vi.fn(),
  findByStripeCustomerId: vi.fn(),
  retrieveCharge: vi.fn(),
  alertFraudBlock: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  creditLotRepository: {},
  creditTransactionRepository: {},
  userRepository: { findByStripeCustomerId: mocks.findByStripeCustomerId },
}));
vi.mock('@bike4mind/services', () => ({ userService: { forfeitPaymentUnlock: mocks.forfeitPaymentUnlock } }));
vi.mock('@server/auth/signupProtection', () => ({ signupProtection: {} }));
vi.mock('@server/billing/fraudBlockAlert', () => ({ alertFraudBlock: mocks.alertFraudBlock }));
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
    mocks.findByStripeCustomerId.mockImplementation(async id => (id === 'cus_1' ? { id: 'user_1' } : null));
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

  it('resolves the warned charge payer, and warns when there is none', async () => {
    mocks.retrieveCharge.mockResolvedValueOnce({ customer: 'cus_1' }).mockResolvedValueOnce({ customer: 'cus_x' });
    await forfeitHeldUnlockForFraudWarning({ id: 'issfr_1', charge: 'ch_1' }, logger);
    await forfeitHeldUnlockForFraudWarning({ id: 'issfr_2', charge: { id: 'ch_2' } }, logger);
    expect(mocks.retrieveCharge.mock.calls).toEqual([['ch_1'], ['ch_2']]);
    expect(forfeitedWith()).toEqual([['user_1', 'fraud_warning']]);
    expect(logger.warn).toHaveBeenCalledWith('Could not find user for early fraud warning issfr_2');
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

  it('propagates a failed forfeit so the webhook is retried', async () => {
    mocks.forfeitPaymentUnlock.mockRejectedValueOnce(new Error('write failed'));
    await expect(forfeitHeldUnlockForRefund({ customer: 'cus_1' }, logger)).rejects.toThrow('write failed');
  });
});
