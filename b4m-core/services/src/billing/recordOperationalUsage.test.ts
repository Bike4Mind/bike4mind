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

  it('writes the caller price stamp onto the UsageEvent, and nothing when there is none', async () => {
    setToggles({ bill: false, enforce: true });
    const record = vi.fn().mockResolvedValue(null);
    const priceStamp = {
      priceSource: 'catalog' as const,
      priceRowId: 'price-row-1',
      rates: { tierKey: 200_000, input: 3e-6, output: 15e-6, cacheRead: 3e-7, cacheWrite: 3.75e-6 },
      turnUsage: [
        { inputTokens: 60, outputTokens: 10, tierKey: 200_000 },
        { inputTokens: 40, outputTokens: 10, tierKey: 200_000 },
      ],
    };

    await recordOperationalUsage({ ...baseParams, priceStamp }, { db: fullBillingDb(record), logger });
    expect(record.mock.calls[0][0]).toMatchObject(priceStamp);

    record.mockClear();
    await recordOperationalUsage(baseParams, { db: fullBillingDb(record), logger });
    expect(record.mock.calls[0][0]).not.toHaveProperty('priceSource');
    expect(record.mock.calls[0][0]).not.toHaveProperty('rates');
  });

  it('deducts credits and records them when both toggles are on and billing repos are present', async () => {
    setToggles({ bill: true, enforce: true });
    const record = vi.fn().mockResolvedValue(null);

    await recordOperationalUsage(baseParams, { db: fullBillingDb(record), logger });

    expect(deductMock).toHaveBeenCalledTimes(1);
    // 0.001 usd * 100000 (mocked) = 100 credits.
    expect(record.mock.calls[0][0]).toMatchObject({ creditsCharged: 100 });
  });

  it('records the authenticating API key on the debit', async () => {
    setToggles({ bill: true, enforce: true });

    await recordOperationalUsage(
      { ...baseParams, apiKeyId: 'key-1' },
      { db: fullBillingDb(vi.fn().mockResolvedValue(null)), logger }
    );

    expect(deductMock).toHaveBeenCalledWith(expect.objectContaining({ apiKeyId: 'key-1' }), expect.anything());
  });

  it('stays recorded-only when the toggle is on but billing repos are absent (a host that does not bill)', async () => {
    setToggles({ bill: true, enforce: true });
    const record = vi.fn().mockResolvedValue(null);

    await recordOperationalUsage(baseParams, {
      db: { usageEvents: { record }, adminSettings: {} as never },
      logger,
    });

    expect(deductMock).not.toHaveBeenCalled();
    expect(record.mock.calls[0][0]).toMatchObject({ creditsCharged: 0 });
  });

  // A record-only host can issue one record per search/tool call, so a fresh flag read here
  // would be a per-call round-trip on a path that can never reach the debit branch.
  it('does not read the billing flags at all when billing repos are absent', async () => {
    setToggles({ bill: true, enforce: true });
    const record = vi.fn().mockResolvedValue(null);

    await recordOperationalUsage(baseParams, {
      db: { usageEvents: { record }, adminSettings: {} as never },
      logger,
    });

    expect(record).toHaveBeenCalledTimes(1);
    expect(getSettingsValueMock).not.toHaveBeenCalled();
    expect(deductMock).not.toHaveBeenCalled();
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

  describe('free-tier holders', () => {
    const plans = (hasActivePlan: boolean) => ({ hasActivePlan: vi.fn().mockResolvedValue(hasActivePlan) });

    it('debits a holder with no purchase and no plan even when billOperationalUsage is off', async () => {
      setToggles({ bill: false, enforce: true });
      const record = vi.fn().mockResolvedValue(null);
      const activePlans = plans(false);

      await recordOperationalUsage(baseParams, { db: { ...fullBillingDb(record), activePlans }, logger });

      expect(activePlans.hasActivePlan).toHaveBeenCalledWith('u1');
      expect(deductMock).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][0]).toMatchObject({ creditsCharged: 100 });
    });

    it.each([
      ['an active plan', { user, activePlans: plans(true) }],
      ['a credit purchase', { user: { id: 'u1', lastCreditsPurchasedAt: new Date() }, activePlans: plans(false) }],
      // An org-funded member: no personal purchase, no plan, and nothing on the org says it is funded.
      ['an org paying for it', { user, organization: { id: 'org1' }, activePlans: plans(false) }],
    ])('stays recorded-only for a holder with %s while the toggle is off', async (_label, holder) => {
      setToggles({ bill: false, enforce: true });
      const record = vi.fn().mockResolvedValue(null);

      await recordOperationalUsage(
        { ...baseParams, user: holder.user as never, organization: (holder.organization ?? null) as never },
        { db: { ...fullBillingDb(record), activePlans: holder.activePlans }, logger }
      );

      expect(deductMock).not.toHaveBeenCalled();
      expect(record.mock.calls[0][0]).toMatchObject({ creditsCharged: 0 });
    });

    it('never debits a free-tier holder when credits are not enforced', async () => {
      setToggles({ bill: false, enforce: false });
      const record = vi.fn().mockResolvedValue(null);

      await recordOperationalUsage(baseParams, {
        db: { ...fullBillingDb(record), activePlans: plans(false) },
        logger,
      });

      expect(deductMock).not.toHaveBeenCalled();
    });

    it('records unbilled when the plan read fails', async () => {
      setToggles({ bill: false, enforce: true });
      const record = vi.fn().mockResolvedValue(null);
      const activePlans = { hasActivePlan: vi.fn().mockRejectedValue(new Error('plans down')) };

      await recordOperationalUsage(baseParams, { db: { ...fullBillingDb(record), activePlans }, logger });

      expect(deductMock).not.toHaveBeenCalled();
      expect(record).toHaveBeenCalledTimes(1);
    });
  });

  it('uses a caller-scoped billing check when one is given', async () => {
    const record = vi.fn().mockResolvedValue(null);
    const billingCheck = vi.fn().mockResolvedValue(true);
    const activePlans = { hasActivePlan: vi.fn() };

    await recordOperationalUsage(baseParams, {
      db: { ...fullBillingDb(record), activePlans },
      billingCheck,
      logger,
    });

    expect(billingCheck).toHaveBeenCalledWith({ user, organization: undefined, activePlans });
    expect(getSettingsValueMock).not.toHaveBeenCalled();
    expect(deductMock).toHaveBeenCalledTimes(1);
  });

  it.each([0, 7])('records %s caller-settled credits without debiting again', async settledCredits => {
    setToggles({ bill: true, enforce: true });
    const record = vi.fn().mockResolvedValue(null);

    await recordOperationalUsage({ ...baseParams, settledCredits }, { db: fullBillingDb(record), logger });

    expect(deductMock).not.toHaveBeenCalled();
    expect(record.mock.calls[0][0]).toMatchObject({ creditsCharged: settledCredits });
  });

  it('is a no-op-safe when no usageEvents repo is wired', async () => {
    setToggles({ bill: false, enforce: true });
    await expect(
      recordOperationalUsage(baseParams, { db: { adminSettings: {} as never }, logger })
    ).resolves.toBeUndefined();
  });

  it('never deducts credits when bypassCreditBilling is set, even with both toggles on', async () => {
    setToggles({ bill: true, enforce: true });
    const record = vi.fn().mockResolvedValue(null);

    await recordOperationalUsage({ ...baseParams, bypassCreditBilling: true }, { db: fullBillingDb(record), logger });

    expect(deductMock).not.toHaveBeenCalled();
    expect(record.mock.calls[0][0]).toMatchObject({ creditsCharged: 0 });
  });

  // The counterpart of bypassCreditBilling, for spend with its own credit economics (data-lake
  // research): billed even though `billOperationalUsage` defaults off, which is what makes the
  // start-pre-flight and this settlement agree.
  it('deducts credits with forceCreditBilling even when billOperationalUsage is off', async () => {
    setToggles({ bill: false, enforce: true });
    const record = vi.fn().mockResolvedValue(null);

    await recordOperationalUsage({ ...baseParams, forceCreditBilling: true }, { db: fullBillingDb(record), logger });

    expect(deductMock).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({ creditsCharged: 100 });
  });

  // Not a way past the platform master switch: a deployment that does not meter credits has no
  // ledger to debit, so research is recorded as platform cost exactly as before.
  it('does not deduct with forceCreditBilling when enforceCredits is off', async () => {
    setToggles({ bill: true, enforce: false });
    const record = vi.fn().mockResolvedValue(null);

    await recordOperationalUsage({ ...baseParams, forceCreditBilling: true }, { db: fullBillingDb(record), logger });

    expect(deductMock).not.toHaveBeenCalled();
    expect(record.mock.calls[0][0]).toMatchObject({ creditsCharged: 0 });
  });

  it('lets bypassCreditBilling win over forceCreditBilling', async () => {
    setToggles({ bill: true, enforce: true });
    const record = vi.fn().mockResolvedValue(null);

    await recordOperationalUsage(
      { ...baseParams, bypassCreditBilling: true, forceCreditBilling: true },
      { db: fullBillingDb(record), logger }
    );

    expect(deductMock).not.toHaveBeenCalled();
    expect(record.mock.calls[0][0]).toMatchObject({ creditsCharged: 0 });
  });

  it('threads dataLakeId onto the recorded event', async () => {
    setToggles({ bill: false, enforce: true });
    const record = vi.fn().mockResolvedValue(null);

    await recordOperationalUsage({ ...baseParams, dataLakeId: 'lake1' }, { db: fullBillingDb(record), logger });

    expect(record.mock.calls[0][0]).toMatchObject({ dataLakeId: 'lake1' });
  });

  it('leaves dataLakeId unset for callers that do not pass one', async () => {
    setToggles({ bill: false, enforce: true });
    const record = vi.fn().mockResolvedValue(null);

    await recordOperationalUsage(baseParams, { db: fullBillingDb(record), logger });

    expect(record.mock.calls[0][0].dataLakeId).toBeUndefined();
  });
});
