import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';

// Control the admin-settings gate directly instead of standing up the settings cache.
const getSettingsValueMock = vi.fn();
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: (key: string) => getSettingsValueMock(key),
}));

// usdToCreditsStochastic is stochastic; pin it so credit assertions are deterministic.
vi.mock('@bike4mind/common', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/common')>();
  return { ...actual, usdToCreditsStochastic: (usd: number) => Math.round(usd * 100000) };
});

const deductMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../creditService', () => ({
  deductCreditsWithOrgSupport: (...args: unknown[]) => deductMock(...args),
}));

import { recordOperationalUsage } from './recordOperationalUsage';

const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn() } as never;
const user = { id: 'u1' } as never;

function setToggles({ bill, enforce }: { bill: boolean; enforce: boolean }) {
  getSettingsValueMock.mockImplementation((key: string) => {
    if (key === 'billOperationalUsage') return bill;
    if (key === 'enforceCredits') return enforce;
    return undefined;
  });
}

function fullBillingDb(record = vi.fn().mockResolvedValue(null)) {
  return {
    usageEvents: { record },
    adminSettings: {} as never,
    creditTransactions: {} as never,
    users: {} as never,
    organizations: {} as never,
  };
}

const baseParams = {
  requestId: 'r1',
  user,
  sessionId: 's1',
  feature: 'operations' as const,
  provider: 'openai',
  model: 'gpt-4o-mini',
  inputTokens: 100,
  outputTokens: 20,
  costUsd: 0.001,
};

beforeEach(() => {
  deductMock.mockClear();
  getSettingsValueMock.mockReset();
});

describe('recordOperationalUsage', () => {
  it('records a UsageEvent with zero credits and no deduction by default (recorded-only)', async () => {
    setToggles({ bill: false, enforce: true });
    const record = vi.fn().mockResolvedValue(null);

    await recordOperationalUsage(baseParams, { db: fullBillingDb(record), logger });

    expect(deductMock).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      feature: 'operations',
      ownerType: CreditHolderType.User,
      ownerId: 'u1',
      creditsCharged: 0,
      costUsd: 0.001,
      settledBasis: 'local',
    });
  });

  it('deducts credits and records them when both toggles are on and billing repos are present', async () => {
    setToggles({ bill: true, enforce: true });
    const record = vi.fn().mockResolvedValue(null);

    await recordOperationalUsage(baseParams, { db: fullBillingDb(record), logger });

    expect(deductMock).toHaveBeenCalledTimes(1);
    // 0.001 usd * 100000 (mocked) = 100 credits.
    expect(record.mock.calls[0][0]).toMatchObject({ creditsCharged: 100 });
  });

  it('stays recorded-only when the toggle is on but billing repos are absent (tool context)', async () => {
    setToggles({ bill: true, enforce: true });
    const record = vi.fn().mockResolvedValue(null);

    await recordOperationalUsage(baseParams, {
      db: { usageEvents: { record }, adminSettings: {} as never },
      logger,
    });

    expect(deductMock).not.toHaveBeenCalled();
    expect(record.mock.calls[0][0]).toMatchObject({ creditsCharged: 0 });
  });

  it('does not bill when enforceCredits is off even if billOperationalUsage is on', async () => {
    setToggles({ bill: true, enforce: false });
    const record = vi.fn().mockResolvedValue(null);

    await recordOperationalUsage(baseParams, { db: fullBillingDb(record), logger });

    expect(deductMock).not.toHaveBeenCalled();
    expect(record.mock.calls[0][0]).toMatchObject({ creditsCharged: 0 });
  });

  it('attributes to the organization when one is provided', async () => {
    setToggles({ bill: false, enforce: true });
    const record = vi.fn().mockResolvedValue(null);

    await recordOperationalUsage(
      { ...baseParams, organization: { id: 'org1' } as never },
      { db: fullBillingDb(record), logger }
    );

    expect(record.mock.calls[0][0]).toMatchObject({
      ownerType: CreditHolderType.Organization,
      ownerId: 'org1',
    });
  });

  it('still records the event when the deduction throws (billing must not block analytics)', async () => {
    setToggles({ bill: true, enforce: true });
    deductMock.mockRejectedValueOnce(new Error('ledger down'));
    const record = vi.fn().mockResolvedValue(null);

    await recordOperationalUsage(baseParams, { db: fullBillingDb(record), logger });

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({ creditsCharged: 0 });
  });

  it('is a no-op-safe when no usageEvents repo is wired', async () => {
    setToggles({ bill: false, enforce: true });
    await expect(
      recordOperationalUsage(baseParams, { db: { adminSettings: {} as never }, logger })
    ).resolves.toBeUndefined();
  });
});
