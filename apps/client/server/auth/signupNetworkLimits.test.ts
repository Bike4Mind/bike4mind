import type { IUserDocument } from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindBySettingName = vi.fn();
const mockRecentDistinctSignups = vi.fn();
const mockFindSignupsSince = vi.fn();
const mockTraceCounts = vi.fn();
const mockRetainTraces = vi.fn();

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findBySettingName: (...args: unknown[]) => mockFindBySettingName(...args) },
  authEventRepository: {
    recentDistinctSignups: (...args: unknown[]) => mockRecentDistinctSignups(...args),
    findSignupsSince: (...args: unknown[]) => mockFindSignupsSince(...args),
  },
  signupTraceRepository: {
    recentDistinctSignups: (...args: unknown[]) => mockTraceCounts(...args),
    retain: (...args: unknown[]) => mockRetainTraces(...args),
  },
}));

import {
  assertSignupNetworkWithinLimits,
  createSignupRiskCollector,
  hashSignupNetwork,
  isSignupNetworkOverLimit,
  retainDeletedSignupTraces,
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

type TraceQuery = { ipHash: string | null; prefixHash: string | null; asn: number | null };
// Deleted-account traces: `found` per asked count, null for a count that was not asked.
const traces = (found: { ip?: number | null; prefix?: number | null; asn?: number | null } = {}) =>
  mockTraceCounts.mockImplementation(async ({ ipHash, prefixHash, asn }: TraceQuery) => ({
    ipSignups: ipHash ? (found.ip === undefined ? 0 : found.ip) : null,
    prefixSignups: prefixHash ? (found.prefix === undefined ? 0 : found.prefix) : null,
    asnSignups: asn ? (found.asn === undefined ? 0 : found.asn) : null,
  }));

beforeEach(() => {
  mockFindBySettingName.mockReset();
  mockRecentDistinctSignups.mockReset();
  mockFindSignupsSince.mockReset();
  mockTraceCounts.mockReset();
  mockRetainTraces.mockReset().mockResolvedValue(undefined);
  traces();
  logger.warn.mockReset();
});

describe('createSignupRiskCollector', () => {
  const user = (signupMeta: unknown = null) => ({ id: 'u1', signupMeta }) as unknown as IUserDocument;

  it("reports the request network's datacenter flag and other accounts' recent signups", async () => {
    counts({ ipSignups: 2, prefixSignups: 5 }, 9);

    const signals = await createSignupRiskCollector(network)(user());

    expect(signals).toEqual({ datacenter: true, ipSignups: 2, prefixSignups: 5, asnSignups: 9 });
    expect(mockRecentDistinctSignups).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', ip: network.ip }));
    expect(mockRecentDistinctSignups).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', asn: network.asn }));
  });

  it('falls back to the recorded signupMeta, anchored at its capture time', async () => {
    counts({ ipSignups: 0, prefixSignups: 0 }, 0);
    const capturedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    const signals = await createSignupRiskCollector()(user({ ...network, isDatacenter: false, capturedAt }));

    expect(signals.datacenter).toBe(false);
    for (const [call] of mockRecentDistinctSignups.mock.calls) expect(call.until).toEqual(capturedAt);
  });

  it('leaves the counts missing for a signup older than AuthEvent retention', async () => {
    const capturedAt = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);

    expect(await createSignupRiskCollector()(user({ ...network, capturedAt }))).toEqual({ datacenter: true });
    expect(mockRecentDistinctSignups).not.toHaveBeenCalled();
  });

  it('leaves the counts missing when the recorded signupMeta has no capture time', async () => {
    expect(await createSignupRiskCollector()(user(network))).toEqual({ datacenter: true });
    expect(mockRecentDistinctSignups).not.toHaveBeenCalled();
  });

  it('scans the 24h window for ip only and the 1h window for ASN only', async () => {
    counts({ ipSignups: 0, prefixSignups: 0 }, 0);

    await createSignupRiskCollector(network)(user());

    expect(mockRecentDistinctSignups).toHaveBeenCalledTimes(2);
    expect(mockRecentDistinctSignups).toHaveBeenCalledWith(
      expect.objectContaining({ ip: network.ip, asn: null, prefix: true })
    );
    expect(mockRecentDistinctSignups).toHaveBeenCalledWith(expect.objectContaining({ ip: null, asn: network.asn }));
  });

  it('rejects when the trace count fails, so the grant is retried', async () => {
    counts({ ipSignups: 0, prefixSignups: 0 }, 0);
    mockTraceCounts.mockRejectedValue(new Error('timeout'));
    await expect(createSignupRiskCollector(network)(user())).rejects.toThrow('timeout');
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

  it('skips the window of a cap that is off', async () => {
    settings({ maxSignupsPerIpPerDay: '3' });
    counts({ ipSignups: 0, prefixSignups: 0 }, 0);
    await isSignupNetworkOverLimit(network, logger);
    expect(mockRecentDistinctSignups).toHaveBeenCalledTimes(1);
    expect(mockRecentDistinctSignups).toHaveBeenCalledWith(
      expect.objectContaining({ ip: network.ip, asn: null, prefix: false })
    );
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

  it('counts live signups only when the trace count fails, and warns', async () => {
    settings({ maxSignupsPerIpPerDay: '2' });
    mockTraceCounts.mockRejectedValue(new Error('timeout'));
    counts({ ipSignups: 2, prefixSignups: 0 }, null);
    expect(await isSignupNetworkOverLimit(network, logger)).toBe(true);
    counts({ ipSignups: 1, prefixSignups: 0 }, null);
    logger.warn.mockReset();
    expect(await isSignupNetworkOverLimit(network, logger)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      '[signup-limits] Signup trace count failed; counting live signups only',
      expect.any(Error)
    );
  });

  it('still fails open when the live count fails alongside the trace count', async () => {
    settings({ maxSignupsPerIpPerDay: '1' });
    mockTraceCounts.mockRejectedValue(new Error('timeout'));
    mockRecentDistinctSignups.mockRejectedValue(new Error('timeout'));
    expect(await isSignupNetworkOverLimit(network, logger)).toBe(false);
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

describe('deleted-account signup traces', () => {
  it('counts a deleted account toward the IP cap', async () => {
    settings({ maxSignupsPerIpPerDay: '3' });
    counts({ ipSignups: 1, prefixSignups: 1 }, 0);
    traces({ ip: 2 });

    expect(await isSignupNetworkOverLimit(network, logger)).toBe(true);
    expect(mockTraceCounts).toHaveBeenCalledWith(
      expect.objectContaining({ ipHash: hashSignupNetwork(network.ip).ipHash, prefixHash: null, asn: null })
    );
  });

  it('counts a deleted account toward the ASN cap and the risk signals', async () => {
    settings({ maxSignupsPerAsnPerHour: '10' });
    counts({ ipSignups: 0, prefixSignups: 0 }, 7);
    traces({ asn: 3 });
    expect(await isSignupNetworkOverLimit(network, logger)).toBe(true);

    counts({ ipSignups: 1, prefixSignups: 2 }, 0);
    traces({ ip: 1, prefix: 4, asn: 5 });
    const signals = await createSignupRiskCollector(network)({ id: 'u1' } as unknown as IUserDocument);
    expect(signals).toEqual({ datacenter: true, ipSignups: 2, prefixSignups: 6, asnSignups: 5 });
  });

  it('treats a truncated trace scan as over', async () => {
    settings({ maxSignupsPerIpPerDay: '3' });
    counts({ ipSignups: 0, prefixSignups: 0 }, 0);
    traces({ ip: null });
    expect(await isSignupNetworkOverLimit(network, logger)).toBe(true);
  });

  it('keeps the last 24h of signups under the same hashes the counts look up, with no raw IP', async () => {
    const signedUpAt = new Date();
    mockFindSignupsSince.mockResolvedValue([
      { ip: '198.51.100.7', asn: 64500, createdAt: signedUpAt },
      { ip: '2001:db8::1', asn: null, createdAt: signedUpAt },
    ]);

    expect(await retainDeletedSignupTraces('u9')).toBe(2);

    const [userId, since] = mockFindSignupsSince.mock.calls[0];
    expect(userId).toBe('u9');
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(SIGNUP_NETWORK_WINDOWS.ipMs);
    const [kept] = mockRetainTraces.mock.calls[0];
    expect(kept).toEqual([
      { accountHash: expect.any(String), signedUpAt, asn: 64500, ...hashSignupNetwork('198.51.100.7') },
      { accountHash: kept[0].accountHash, signedUpAt, asn: null, ...hashSignupNetwork('2001:db8::1') },
    ]);
    expect(kept[1].prefixHash).toBeNull();
    expect(JSON.stringify(kept)).not.toMatch(/198\.51|2001:db8|u9/);
  });

  it('hashes the /24 apart from the address, and nothing for a missing IP', () => {
    const a = hashSignupNetwork('198.51.100.7');
    const b = hashSignupNetwork('198.51.100.8');
    expect(a.ipHash).not.toBe(b.ipHash);
    expect(a.prefixHash).toBe(b.prefixHash);
    expect(hashSignupNetwork(null)).toEqual({ ipHash: null, prefixHash: null });
    expect(hashSignupNetwork('unknown')).toEqual({ ipHash: null, prefixHash: null });
  });
});
