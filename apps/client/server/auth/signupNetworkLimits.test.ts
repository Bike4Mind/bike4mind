import type { IUserDocument } from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindBySettingName = vi.fn();
const mockRecentDistinctSignups = vi.fn();

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findBySettingName: (...args: unknown[]) => mockFindBySettingName(...args) },
  authEventRepository: { recentDistinctSignups: (...args: unknown[]) => mockRecentDistinctSignups(...args) },
}));

import {
  assertSignupNetworkWithinLimits,
  createSignupRiskCollector,
  isSignupNetworkOverLimit,
  SIGNUP_NETWORK_WINDOWS,
} from './signupNetworkLimits';

const network = { ip: '198.51.100.7', asn: 64500, isDatacenter: true };
const logger = { warn: vi.fn() };
const settings = (values: Record<string, string>) =>
  mockFindBySettingName.mockImplementation(async (key: string) =>
    key in values ? { settingValue: values[key] } : null
  );
// The 24h window answers ip/prefix, the 1h window answers asn.
const counts = (day: { ipSignups: number | null; prefixSignups: number | null }, asnSignups: number | null) =>
  mockRecentDistinctSignups.mockImplementation(async ({ since, until }: { since: Date; until: Date }) =>
    until.getTime() - since.getTime() === SIGNUP_NETWORK_WINDOWS.ipMs
      ? { ...day, asnSignups: -1 }
      : { ipSignups: -1, prefixSignups: -1, asnSignups }
  );

beforeEach(() => {
  mockFindBySettingName.mockReset();
  mockRecentDistinctSignups.mockReset();
  logger.warn.mockReset();
});

describe('createSignupRiskCollector', () => {
  const user = (signupMeta: unknown = null) => ({ id: 'u1', signupMeta }) as unknown as IUserDocument;

  it("reports the request network's datacenter flag and other accounts' recent signups", async () => {
    counts({ ipSignups: 2, prefixSignups: 5 }, 9);

    const signals = await createSignupRiskCollector(network)(user());

    expect(signals).toEqual({ datacenter: true, ipSignups: 2, prefixSignups: 5, asnSignups: 9 });
    expect(mockRecentDistinctSignups).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', ip: network.ip, asn: network.asn })
    );
  });

  it('falls back to the recorded signupMeta, anchored at its capture time', async () => {
    counts({ ipSignups: 0, prefixSignups: 0 }, 0);
    const capturedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    const signals = await createSignupRiskCollector()(user({ ...network, isDatacenter: false, capturedAt }));

    expect(signals.datacenter).toBe(false);
    for (const [call] of mockRecentDistinctSignups.mock.calls) expect(call.until).toEqual(capturedAt);
  });

  it('keeps an old signup inside the AuthEvent retention window', async () => {
    counts({ ipSignups: 0, prefixSignups: 0 }, 0);
    const capturedAt = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);

    await createSignupRiskCollector()(user({ ...network, capturedAt }));

    for (const [call] of mockRecentDistinctSignups.mock.calls)
      expect(call.since.getTime()).toBeGreaterThan(Date.now() - 90 * 24 * 60 * 60 * 1000);
  });

  it('leaves every signal missing when no network is known', async () => {
    expect(await createSignupRiskCollector(null)(user())).toEqual({});
    expect(mockRecentDistinctSignups).not.toHaveBeenCalled();
  });
});

describe('isSignupNetworkOverLimit', () => {
  it('is off by default without counting', async () => {
    settings({});
    expect(await isSignupNetworkOverLimit(network, logger)).toBe(false);
    expect(mockRecentDistinctSignups).not.toHaveBeenCalled();
  });

  it('refuses once the IP reached its daily cap', async () => {
    settings({ maxSignupsPerIpPerDay: '3' });
    counts({ ipSignups: 3, prefixSignups: 3 }, 0);
    expect(await isSignupNetworkOverLimit(network, logger)).toBe(true);
  });

  it('refuses once the ASN reached its hourly cap, and counts every account', async () => {
    settings({ maxSignupsPerAsnPerHour: '10' });
    counts({ ipSignups: 0, prefixSignups: 0 }, 10);
    expect(await isSignupNetworkOverLimit(network, logger)).toBe(true);
    expect(mockRecentDistinctSignups.mock.calls[0][0].userId).toBeUndefined();
  });

  it('allows a network below its caps', async () => {
    settings({ maxSignupsPerIpPerDay: '3', maxSignupsPerAsnPerHour: '10' });
    counts({ ipSignups: 2, prefixSignups: 40 }, 9);
    expect(await isSignupNetworkOverLimit(network, logger)).toBe(false);
  });

  it('treats a truncated count as over, but an unknown network as allowed', async () => {
    settings({ maxSignupsPerAsnPerHour: '10' });
    counts({ ipSignups: 0, prefixSignups: 0 }, null);
    expect(await isSignupNetworkOverLimit(network, logger)).toBe(true);
    expect(await isSignupNetworkOverLimit({ ...network, asn: null }, logger)).toBe(false);
  });

  it('fails open when the count fails', async () => {
    settings({ maxSignupsPerIpPerDay: '1' });
    mockRecentDistinctSignups.mockRejectedValue(new Error('timeout'));
    expect(await isSignupNetworkOverLimit(network, logger)).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('ignores a malformed cap', async () => {
    settings({ maxSignupsPerIpPerDay: 'abc' });
    expect(await isSignupNetworkOverLimit(network, logger)).toBe(false);
  });

  it('throws a 429 from the assert form', async () => {
    settings({ maxSignupsPerIpPerDay: '1' });
    counts({ ipSignups: 1, prefixSignups: 1 }, 0);
    await expect(assertSignupNetworkWithinLimits(network, logger)).rejects.toMatchObject({ statusCode: 429 });
  });
});
