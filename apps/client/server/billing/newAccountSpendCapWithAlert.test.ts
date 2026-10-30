import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ alertFraudBlock: vi.fn(async () => undefined), personalSpendSince: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  newAccountSpendCapAdapters: { adminSettings: { name: 'settings' }, personalSpendSince: mocks.personalSpendSince },
}));
vi.mock('@server/billing/fraudBlockAlert', () => ({ alertFraudBlock: mocks.alertFraudBlock }));

import { newAccountSpendCapAdaptersWithAlert } from './newAccountSpendCapWithAlert';

describe('newAccountSpendCapAdaptersWithAlert', () => {
  it('keeps the database adapters and alerts LiveOps on a refusal', async () => {
    expect(newAccountSpendCapAdaptersWithAlert.adminSettings).toEqual({ name: 'settings' });
    const since = new Date('2026-10-31T00:00:00.000Z');
    await newAccountSpendCapAdaptersWithAlert.personalSpendSince('u1', since);
    expect(mocks.personalSpendSince).toHaveBeenCalledWith('u1', since);

    await newAccountSpendCapAdaptersWithAlert.onRefused?.({
      userId: 'u1',
      requestedCredits: 1_200.4,
      refusal: { window: 'hour', capCredits: 10_000, spentCredits: 9_500.2, resetsAt: null },
    });

    expect(mocks.alertFraudBlock).toHaveBeenCalledExactlyOnceWith({
      kind: 'newAccountSpendCap',
      userId: 'u1',
      details: ['*Cap:* 10,000 credits per hour, 9,501 spent, 1,201 requested'],
    });
  });
});
