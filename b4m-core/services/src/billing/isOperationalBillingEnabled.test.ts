import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getSettingsMapMock, getSettingsValueMock } = vi.hoisted(() => ({
  getSettingsMapMock: vi.fn(),
  getSettingsValueMock: vi.fn(),
}));

vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: getSettingsMapMock,
  getSettingsValue: (key: string, settings: Record<string, string>) => getSettingsValueMock(key, settings),
}));

import {
  areCreditsEnforced,
  isOperationalBillingEnabled,
  memoizeOperationalBillingCheck,
} from './isOperationalBillingEnabled';

const db = { adminSettings: {} as never };

const setToggles = ({ bill, enforce }: { bill: boolean; enforce: boolean }) =>
  getSettingsValueMock.mockImplementation((key: string) => {
    if (key === 'billOperationalUsage') return bill;
    if (key === 'enforceCredits') return enforce;
    return undefined;
  });

describe('isOperationalBillingEnabled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingsMapMock.mockResolvedValue({});
  });

  // Both gates, in every combination: a pre-flight that disagreed with the settlement on any
  // one of these would either reject unbillable work or leave the gap it exists to close.
  it.each([
    { bill: true, enforce: true, expected: true },
    { bill: true, enforce: false, expected: false },
    { bill: false, enforce: true, expected: false },
    { bill: false, enforce: false, expected: false },
  ])(
    'is $expected when billOperationalUsage=$bill and enforceCredits=$enforce',
    async ({ bill, enforce, expected }) => {
      setToggles({ bill, enforce });

      await expect(isOperationalBillingEnabled(db)).resolves.toBe(expected);
    }
  );

  // A setting absent from the store reads undefined, which must gate billing OFF rather than
  // throwing or coercing to on.
  it('is false when neither setting is present', async () => {
    getSettingsValueMock.mockReturnValue(undefined);

    await expect(isOperationalBillingEnabled(db)).resolves.toBe(false);
  });

  // Owns the fetch so no caller can narrow it to the wrong keys: under skipCache a named read
  // returns only what is listed, and an omitted key gates billing OFF with no error anywhere.
  // skipCache is what makes an admin flip land on the next call from a long-lived process.
  it('reads exactly the two gating keys straight from the store', async () => {
    setToggles({ bill: true, enforce: true });

    await isOperationalBillingEnabled(db);

    expect(getSettingsMapMock).toHaveBeenCalledWith(db, {
      logger: undefined,
      names: ['billOperationalUsage', 'enforceCredits'],
      skipCache: true,
    });
  });

  it('propagates a settings-store failure so each caller picks its own fallback', async () => {
    getSettingsMapMock.mockRejectedValue(new Error('mongo down'));

    await expect(isOperationalBillingEnabled(db)).rejects.toThrow('mongo down');
  });
});

describe('isOperationalBillingEnabled with a holder', () => {
  const holder = (overrides: { lastCreditsPurchasedAt?: Date; orgPays?: boolean; hasActivePlan?: boolean } = {}) => ({
    user: { id: 'u1', lastCreditsPurchasedAt: overrides.lastCreditsPurchasedAt ?? null },
    organization: overrides.orgPays ? { id: 'org1' } : null,
    activePlans: { hasActivePlan: vi.fn().mockResolvedValue(overrides.hasActivePlan ?? false) },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getSettingsMapMock.mockResolvedValue({});
  });

  it('bills a free-tier user paying for themselves with the toggle off when credits are enforced', async () => {
    setToggles({ bill: false, enforce: true });

    await expect(isOperationalBillingEnabled(db, undefined, holder())).resolves.toBe(true);
  });

  it.each([
    ['a user credit purchase', { lastCreditsPurchasedAt: new Date() }],
    ['an active plan', { hasActivePlan: true }],
  ])('does not bill a holder with %s while the toggle is off', async (_label, overrides) => {
    setToggles({ bill: false, enforce: true });

    await expect(isOperationalBillingEnabled(db, undefined, holder(overrides))).resolves.toBe(false);
  });

  // No org-level signal says whether a pool is funded (grants, transfers, invoicing), so an org-paid
  // member with no personal purchase and no plan is billed only by the toggle.
  it('never treats org-paid spend as free tier', async () => {
    setToggles({ bill: false, enforce: true });
    const orgMember = holder({ orgPays: true });

    await expect(isOperationalBillingEnabled(db, undefined, orgMember)).resolves.toBe(false);
    expect(orgMember.activePlans.hasActivePlan).not.toHaveBeenCalled();
  });

  it('skips the plan read when a purchase already settles it', async () => {
    setToggles({ bill: false, enforce: true });
    const paid = holder({ lastCreditsPurchasedAt: new Date() });

    await isOperationalBillingEnabled(db, undefined, paid);

    expect(paid.activePlans.hasActivePlan).not.toHaveBeenCalled();
  });

  it('bills a paying holder once the toggle is on, without reading plans', async () => {
    setToggles({ bill: true, enforce: true });
    const paid = holder({ hasActivePlan: true });

    await expect(isOperationalBillingEnabled(db, undefined, paid)).resolves.toBe(true);
    expect(paid.activePlans.hasActivePlan).not.toHaveBeenCalled();
  });

  it('never bills when credits are not enforced, free tier or not', async () => {
    setToggles({ bill: true, enforce: false });

    await expect(isOperationalBillingEnabled(db, undefined, holder())).resolves.toBe(false);
  });

  it('propagates a plan-read failure', async () => {
    setToggles({ bill: false, enforce: true });
    const failing = holder();
    failing.activePlans.hasActivePlan.mockRejectedValue(new Error('plans down'));

    await expect(isOperationalBillingEnabled(db, undefined, failing)).rejects.toThrow('plans down');
  });
});

describe('memoizeOperationalBillingCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingsMapMock.mockResolvedValue({});
    setToggles({ bill: false, enforce: true });
  });

  const freeHolder = () => ({
    user: { id: 'u1', lastCreditsPurchasedAt: null },
    organization: null,
    activePlans: { hasActivePlan: vi.fn().mockResolvedValue(false) },
  });

  it('reads settings and plans once per holder', async () => {
    const check = memoizeOperationalBillingCheck(db);
    const holder = freeHolder();

    await expect(check(holder)).resolves.toBe(true);
    await expect(check(holder)).resolves.toBe(true);

    expect(getSettingsMapMock).toHaveBeenCalledTimes(1);
    expect(holder.activePlans.hasActivePlan).toHaveBeenCalledTimes(1);
  });

  it('keeps holders apart', async () => {
    const check = memoizeOperationalBillingCheck(db);

    await expect(check(freeHolder())).resolves.toBe(true);
    await expect(check({ ...freeHolder(), organization: { id: 'org1' } })).resolves.toBe(false);
    await expect(check()).resolves.toBe(false);

    expect(getSettingsMapMock).toHaveBeenCalledTimes(3);
  });

  it('does not keep a failed read', async () => {
    const check = memoizeOperationalBillingCheck(db);
    getSettingsMapMock.mockRejectedValueOnce(new Error('mongo down'));

    await expect(check(freeHolder())).rejects.toThrow('mongo down');
    await expect(check(freeHolder())).resolves.toBe(true);
  });
});

describe('areCreditsEnforced', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getSettingsMapMock.mockResolvedValue({});
  });

  it.each([true, false, undefined])(
    'returns the enforcement flag %s with absent settings defaulting off',
    async flag => {
      getSettingsValueMock.mockReturnValue(flag);

      await expect(areCreditsEnforced(db)).resolves.toBe(flag ?? false);

      expect(getSettingsMapMock).toHaveBeenCalledWith(db, {
        logger: undefined,
        names: ['enforceCredits'],
        skipCache: true,
      });
      expect(getSettingsValueMock).toHaveBeenCalledWith('enforceCredits', {});
    }
  );

  it('propagates a settings-store failure instead of treating billing as disabled', async () => {
    getSettingsMapMock.mockRejectedValue(new Error('mongo down'));

    await expect(areCreditsEnforced(db)).rejects.toThrow('mongo down');
    expect(getSettingsValueMock).not.toHaveBeenCalled();
  });
});
