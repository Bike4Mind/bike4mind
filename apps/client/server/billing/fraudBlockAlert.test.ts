import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimed: new Set<string>(),
  claimStep: vi.fn(),
  findById: vi.fn(),
  postMessageToSlack: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  paymentRiskActionRepository: { claimStep: mocks.claimStep },
  userRepository: { findById: mocks.findById },
}));
vi.mock('@server/integrations/slack/slack', () => ({ postMessageToSlack: mocks.postMessageToSlack }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'production' } } }));

import {
  alertFraudBlock,
  formatFraudBlockAlert,
  fraudBlockAlertKey,
  resetFraudBlockAlertMemo,
} from './fraudBlockAlert';

const NOW = new Date('2026-10-31T10:15:00.000Z');
const LATER_SAME_HOUR = new Date('2026-10-31T10:59:59.999Z');
const NEXT_HOUR = new Date('2026-10-31T11:00:00.000Z');
const spendCapBlock = { kind: 'newAccountSpendCap' as const, userId: 'u1', details: ['*Cap:* 10 credits per hour'] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  resetFraudBlockAlertMemo();
  mocks.claimed.clear();
  // Stands in for the unique PaymentRiskAction key every container shares.
  mocks.claimStep.mockImplementation(async (key: string, step: string) => {
    const claim = `${key}#${step}`;
    if (mocks.claimed.has(claim)) return false;
    mocks.claimed.add(claim);
    return true;
  });
  mocks.findById.mockResolvedValue({ id: 'u1', stripeCustomerId: 'cus_1' });
  mocks.postMessageToSlack.mockResolvedValue(true);
});

describe('fraudBlockAlertKey', () => {
  it('buckets by clock hour, so the same subject and kind share a key within the hour', () => {
    expect(fraudBlockAlertKey('ipBlocked', 'u1', NOW)).toBe('fraud-block-alert:ipBlocked:u1:2026-10-31T10:00:00.000Z');
    expect(fraudBlockAlertKey('ipBlocked', 'u1', LATER_SAME_HOUR)).toBe(fraudBlockAlertKey('ipBlocked', 'u1', NOW));
    expect(fraudBlockAlertKey('ipBlocked', 'u1', NEXT_HOUR)).not.toBe(fraudBlockAlertKey('ipBlocked', 'u1', NOW));
  });
});

describe('alertFraudBlock', () => {
  it('posts once per user per block kind per hour however often the block fires', async () => {
    for (let attempt = 0; attempt < 5; attempt++) await alertFraudBlock(spendCapBlock, NOW);
    await alertFraudBlock(spendCapBlock, LATER_SAME_HOUR);

    expect(mocks.postMessageToSlack).toHaveBeenCalledTimes(1);
    // Within one container, retries after the first settle without touching the database.
    expect(mocks.claimStep).toHaveBeenCalledTimes(1);
  });

  it('dedupes across containers through the durable claim, not memory', async () => {
    await alertFraudBlock(spendCapBlock, NOW);
    resetFraudBlockAlertMemo();
    await alertFraudBlock(spendCapBlock, NOW);

    expect(mocks.claimStep).toHaveBeenCalledTimes(2);
    expect(mocks.postMessageToSlack).toHaveBeenCalledTimes(1);
  });

  it('posts again for another user, another block kind, or the next hour', async () => {
    await alertFraudBlock(spendCapBlock, NOW);
    await alertFraudBlock({ ...spendCapBlock, userId: 'u2' }, NOW);
    await alertFraudBlock({ ...spendCapBlock, kind: 'checkoutRefused' }, NOW);
    await alertFraudBlock(spendCapBlock, NEXT_HOUR);

    expect(mocks.postMessageToSlack).toHaveBeenCalledTimes(4);
  });

  it('dedupes a signed-out block by IP', async () => {
    const block = { kind: 'ipBlocked' as const, userId: null, ip: '203.0.113.9', details: [] };
    await alertFraudBlock(block, NOW);
    await alertFraudBlock(block, NOW);

    expect(mocks.claimStep).toHaveBeenCalledWith(expect.stringContaining(':203.0.113.9:'), 'slack', null);
    expect(mocks.findById).not.toHaveBeenCalled();
    expect(mocks.postMessageToSlack).toHaveBeenCalledTimes(1);
  });

  it('skips a block with neither a user nor an IP to key it by', async () => {
    await alertFraudBlock({ kind: 'ipBlocked', userId: null, details: [] }, NOW);
    expect(mocks.claimStep).not.toHaveBeenCalled();
  });

  it('never throws, so a failed alert cannot fail the block', async () => {
    mocks.claimStep.mockRejectedValueOnce(new Error('db down'));
    await expect(alertFraudBlock(spendCapBlock, NOW)).resolves.toBeUndefined();

    mocks.postMessageToSlack.mockRejectedValueOnce(new Error('slack down'));
    await expect(alertFraudBlock({ ...spendCapBlock, userId: 'u2' }, NOW)).resolves.toBeUndefined();
  });

  it("links the user's admin page and Stripe customer", async () => {
    vi.stubEnv('APP_URL', 'https://app.example.com');
    await alertFraudBlock(spendCapBlock, NOW);

    const message = mocks.postMessageToSlack.mock.calls[0][0] as string;
    expect(message).toContain('<https://app.example.com/admin/users/u1|Open in admin>');
    expect(message).toContain('<https://dashboard.stripe.com/customers/cus_1|Stripe>');
    expect(message).toContain('*Cap:* 10 credits per hour');
  });
});

describe('formatFraudBlockAlert', () => {
  it('says when the user has no Stripe customer, and uses the test-mode dashboard off production', () => {
    vi.stubEnv('APP_URL', '');
    expect(formatFraudBlockAlert(spendCapBlock, null, 'production')).toContain('`u1` | no Stripe customer');
    expect(formatFraudBlockAlert(spendCapBlock, 'cus_1', 'pr-123')).toContain(
      '<https://dashboard.stripe.com/test/customers/cus_1|Stripe>'
    );
  });

  it('names the IP of a signed-out block', () => {
    const message = formatFraudBlockAlert(
      { kind: 'ipBlocked', userId: null, ip: '203.0.113.9', details: [] },
      null,
      'production'
    );
    expect(message).toContain('*User:* signed out (IP `203.0.113.9`)');
    expect(message).toContain('for this IP');
  });
});
