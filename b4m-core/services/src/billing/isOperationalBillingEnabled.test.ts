import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getSettingsMapMock, getSettingsValueMock } = vi.hoisted(() => ({
  getSettingsMapMock: vi.fn(),
  getSettingsValueMock: vi.fn(),
}));

vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: getSettingsMapMock,
  getSettingsValue: (key: string, settings: Record<string, string>) => getSettingsValueMock(key, settings),
}));

import { areCreditsEnforced, isOperationalBillingEnabled } from './isOperationalBillingEnabled';

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
