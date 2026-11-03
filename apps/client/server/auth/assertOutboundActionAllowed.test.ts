// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_TRUST_REQUIRED_ERROR_CODE } from '@bike4mind/common';

const { getActiveSubscriptionsForUser, getRequestActiveSubscriptions, settingsMap } = vi.hoisted(() => ({
  getActiveSubscriptionsForUser: vi.fn(),
  getRequestActiveSubscriptions: vi.fn(),
  settingsMap: vi.fn(),
}));

vi.mock('@server/entitlements/activeSubscriptions', () => ({
  getActiveSubscriptionsForUser,
  getRequestActiveSubscriptions,
}));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: settingsMap,
}));

import {
  OUTBOUND_ACTIONS_RESTRICTED_MESSAGE,
  assertOutboundActionAllowed,
  outboundActionGate,
} from './assertOutboundActionAllowed';

const DAY_MS = 24 * 60 * 60 * 1000;
const young = {
  id: 'user-1',
  isAdmin: false,
  isModerated: false,
  emailVerified: true,
  apiKeyTrustApproved: false,
  lastCreditsPurchasedAt: null,
  createdAt: new Date(Date.now() - DAY_MS),
};
const old = { ...young, createdAt: new Date(Date.now() - 30 * DAY_MS) };

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { statusCode: number; message: string; additionalInfo?: Record<string, unknown> };
  }
  throw new Error('expected rejection');
};

describe('assertOutboundActionAllowed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsMap.mockResolvedValue({});
    getActiveSubscriptionsForUser.mockResolvedValue([]);
    getRequestActiveSubscriptions.mockResolvedValue([]);
  });

  it('rejects a missing user with 401', async () => {
    expect((await rejection(assertOutboundActionAllowed(undefined))).statusCode).toBe(401);
  });

  it('blocks a moderated but trusted user with a message that is not AI-specific', async () => {
    const error = await rejection(assertOutboundActionAllowed({ ...old, isModerated: true }));
    expect(error.statusCode).toBe(403);
    expect(error.message).toBe(OUTBOUND_ACTIONS_RESTRICTED_MESSAGE);
    expect(error.message).not.toMatch(/\bAI\b/);
  });

  it('still blocks a moderated user when the trust gate is off', async () => {
    settingsMap.mockResolvedValue({ apiKeyTrustGateEnabled: 'false' });
    expect((await rejection(assertOutboundActionAllowed({ ...old, isModerated: true }))).statusCode).toBe(403);
  });

  it('blocks an unverified email with the trust error code', async () => {
    const error = await rejection(assertOutboundActionAllowed({ ...old, emailVerified: false }));
    expect(error.statusCode).toBe(403);
    expect(error.additionalInfo).toMatchObject({
      errorCode: ACCOUNT_TRUST_REQUIRED_ERROR_CODE,
      trustReason: 'email_unverified',
    });
  });

  it('blocks a young free account and names the date it unlocks', async () => {
    const error = await rejection(assertOutboundActionAllowed(young));
    expect(error.statusCode).toBe(403);
    expect(error.additionalInfo).toMatchObject({ errorCode: ACCOUNT_TRUST_REQUIRED_ERROR_CODE });
    const trustedAfter = String(error.additionalInfo?.trustedAfter);
    expect(error.additionalInfo?.trustReason).toBe('not_yet_trusted');
    expect(error.message).toContain(trustedAfter.slice(0, 10));
    expect(error.message).not.toMatch(/API key/i);
  });

  it('passes a young account with an active subscription', async () => {
    getActiveSubscriptionsForUser.mockResolvedValue([{ priceId: 'price_x' }]);
    await expect(assertOutboundActionAllowed(young)).resolves.toBeUndefined();
  });

  it('passes a young account when the trust gate is off', async () => {
    settingsMap.mockResolvedValue({ apiKeyTrustGateEnabled: 'false' });
    await expect(assertOutboundActionAllowed({ ...young, emailVerified: false })).resolves.toBeUndefined();
  });

  it('passes an admin who is young and unverified', async () => {
    await expect(
      assertOutboundActionAllowed({ ...young, isAdmin: true, emailVerified: false })
    ).resolves.toBeUndefined();
  });

  it('passes a verified account past the minimum age', async () => {
    await expect(assertOutboundActionAllowed(old)).resolves.toBeUndefined();
  });
});

describe('outboundActionGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsMap.mockResolvedValue({});
    getRequestActiveSubscriptions.mockResolvedValue([]);
  });

  const run = (user: typeof young) =>
    new Promise<unknown[]>(resolve => {
      const next = vi.fn((...args: unknown[]) => resolve(args));
      outboundActionGate()({ user } as never, {} as never, next);
    });

  it('calls next with no error for a trusted user', async () => {
    expect(await run(old)).toEqual([]);
  });

  it('forwards a 403 to next for an untrusted user', async () => {
    const [error] = await run(young);
    expect((error as { statusCode: number }).statusCode).toBe(403);
  });
});
