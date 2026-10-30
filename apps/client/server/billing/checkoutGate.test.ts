import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  countRadarBlocked: vi.fn(),
  findLinkedAccounts: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  paymentAttemptRepository: { countRadarBlocked: mocks.countRadarBlocked },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: async () => mocks.settings,
}));
vi.mock('@bike4mind/server-utils/auth/signupNetworkSignals', () => ({
  hashSignupNetwork: (ip: string | null) => ({ ipHash: ip ? `hash:${ip}` : null, prefixHash: null }),
}));
vi.mock('@server/billing/linkedAccounts', () => ({
  findLinkedAccounts: mocks.findLinkedAccounts,
}));

import { CHECKOUT_REFUSED_MESSAGE, assertCheckoutAllowed, checkoutRefusal } from './checkoutGate';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const user = { id: 'u1', signupMeta: { ip: '198.51.100.1' } };
const network = { ip: '203.0.113.7' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = {};
  mocks.countRadarBlocked.mockResolvedValue({ account: 0, network: 0 });
  mocks.findLinkedAccounts.mockResolvedValue([]);
});

describe('checkoutRefusal', () => {
  it('allows a clean account', async () => {
    await expect(checkoutRefusal(user, network)).resolves.toBeNull();
    expect(mocks.countRadarBlocked).toHaveBeenCalledWith({
      userId: 'u1',
      ipHash: 'hash:203.0.113.7',
      since: expect.any(Date),
    });
    expect(mocks.findLinkedAccounts).toHaveBeenCalledWith(user, { extraIpHashes: ['hash:203.0.113.7'] });
  });

  it('refuses once the account, or its network, reaches the Radar-block limit', async () => {
    mocks.countRadarBlocked.mockResolvedValue({ account: 3, network: 3 });
    await expect(checkoutRefusal(user, network)).resolves.toEqual({
      reason: 'radarBlocks',
      scope: 'account',
      count: 3,
    });

    mocks.countRadarBlocked.mockResolvedValue({ account: 0, network: 4 });
    await expect(checkoutRefusal(user, network)).resolves.toEqual({
      reason: 'radarBlocks',
      scope: 'network',
      count: 4,
    });

    mocks.countRadarBlocked.mockResolvedValue({ account: 2, network: 2 });
    await expect(checkoutRefusal(user, network)).resolves.toBeNull();
  });

  it('reads the limit and window from settings, and 0 turns the Radar-block check off', async () => {
    mocks.settings = { paymentRiskCheckoutMaxBlockedAttempts: '1', paymentRiskCheckoutBlockedWindowMinutes: '30' };
    mocks.countRadarBlocked.mockResolvedValue({ account: 1, network: 0 });
    const before = Date.now();
    await expect(checkoutRefusal(user, network)).resolves.toMatchObject({ reason: 'radarBlocks' });
    const { since } = mocks.countRadarBlocked.mock.calls[0][0];
    expect(before - since.getTime()).toBeGreaterThanOrEqual(30 * 60_000 - 1000);
    expect(before - since.getTime()).toBeLessThanOrEqual(30 * 60_000 + 1000);

    mocks.settings = { paymentRiskCheckoutMaxBlockedAttempts: '0' };
    mocks.countRadarBlocked.mockClear();
    await expect(checkoutRefusal(user, network)).resolves.toBeNull();
    expect(mocks.countRadarBlocked).not.toHaveBeenCalled();
  });

  it('refuses an account linked to a blocked one, strong or weak', async () => {
    mocks.findLinkedAccounts.mockResolvedValue([
      { id: 'u2', strength: 'strong', blocked: false },
      { id: 'u3', strength: 'weak', blocked: true },
    ]);
    await expect(checkoutRefusal(user, network)).resolves.toEqual({ reason: 'linkedToBlocked', linkedUserId: 'u3' });
  });

  it('ignores links when linked-account actions are off', async () => {
    mocks.settings = { paymentRiskLinkedAccountActions: 'false' };
    mocks.findLinkedAccounts.mockResolvedValue([{ id: 'u3', strength: 'strong', blocked: true }]);
    await expect(checkoutRefusal(user, network)).resolves.toBeNull();
    expect(mocks.findLinkedAccounts).not.toHaveBeenCalled();
  });
});

describe('assertCheckoutAllowed', () => {
  it('throws the neutral message on a refusal', async () => {
    mocks.countRadarBlocked.mockResolvedValue({ account: 5, network: 0 });
    const attempt = assertCheckoutAllowed(user, network, logger, 'credit_purchase');
    await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assertCheckoutAllowed(user, network, logger, 'credit_purchase')).rejects.toThrow(
      CHECKOUT_REFUSED_MESSAGE
    );
  });

  it('lets the checkout through, logged, when the gate itself fails', async () => {
    mocks.countRadarBlocked.mockRejectedValue(new Error('db down'));
    await expect(assertCheckoutAllowed(user, network, logger, 'subscription')).resolves.toBeUndefined();
    expect((logger as unknown as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalled();
  });
});
