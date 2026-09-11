import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getSettingsMapMock, getSettingsValueMock } = vi.hoisted(() => ({
  getSettingsMapMock: vi.fn(),
  getSettingsValueMock: vi.fn(),
}));

vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: getSettingsMapMock,
  getSettingsValue: (key: string, settings: Record<string, string>) => getSettingsValueMock(key, settings),
}));

import { isOperationalBillingEnabled } from './isOperationalBillingEnabled';

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

  // Owns the fetch so no caller can narrow it to the wrong keys: getSettingsMap's `names`
  // option is honoured only under skipCache, so passing it here would be inert anyway.
  it('reads the full cached settings map rather than a named subset', async () => {
    setToggles({ bill: true, enforce: true });

    await isOperationalBillingEnabled(db);

    expect(getSettingsMapMock).toHaveBeenCalledWith(db, { logger: undefined });
  });

  it('propagates a settings-store failure so each caller picks its own fallback', async () => {
    getSettingsMapMock.mockRejectedValue(new Error('mongo down'));

    await expect(isOperationalBillingEnabled(db)).rejects.toThrow('mongo down');
  });
});
