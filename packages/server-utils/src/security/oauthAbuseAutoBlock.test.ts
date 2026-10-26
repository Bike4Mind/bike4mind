import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseEscalationMinutes,
  resolveBlockDurationMs,
  runOauthAbuseAutoBlock,
  OAUTH_ABUSE_REASONS,
  type OauthAbusePolicy,
} from './oauthAbuseAutoBlock';

const h = vi.hoisted(() => ({
  getSettingsMap: vi.fn(),
  getIPs: vi.fn(),
  countForIP: vi.fn(),
  findLatest: vi.fn(),
  countBlocks: vi.fn(),
  block: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { tag: 'settings' },
  authFailLogRepository: {
    getIPsWithHighAttemptsForReasons: h.getIPs,
    countForIPAndReasons: h.countForIP,
  },
  blockedIPRepository: {
    findLatestBlock: h.findLatest,
    countAutoBlocksEndingSince: h.countBlocks,
    block: h.block,
  },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: h.getSettingsMap,
}));

const MIN = 60_000;
const policy: OauthAbusePolicy = {
  enabled: true,
  threshold: 20,
  windowMs: 10 * MIN,
  escalationMs: [10 * MIN, 60 * MIN, 1440 * MIN],
  lookbackMs: 24 * 60 * MIN,
};
const NOW = new Date('2026-01-01T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const setup = (
  overrides: Partial<OauthAbusePolicy> = {},
  prior: Record<string, number> = {},
  latest: Record<string, { active: boolean; expiresAt: Date; unblockedAt?: Date } | null> = {},
  attemptsSince = 0
) => {
  const block = vi.fn().mockResolvedValue({});
  const getIPsWithHighAttempts = vi.fn().mockResolvedValue([
    { ip: '1.1.1.1', attempts: 25 },
    { ip: '2.2.2.2', attempts: 20 },
  ]);
  const countAutoBlocksEndingSince = vi.fn(async (ip: string) => prior[ip] ?? 0);
  const countAttemptsSince = vi.fn(async () => attemptsSince);
  const deps = {
    loadPolicy: async () => ({ ...policy, ...overrides }),
    getIPsWithHighAttempts,
    countAttemptsSince,
    findLatestBlock: vi.fn(async (ip: string) => latest[ip] ?? null),
    countAutoBlocksEndingSince,
    block,
  };
  return { deps, block, getIPsWithHighAttempts, countAutoBlocksEndingSince, countAttemptsSince };
};

describe('runOauthAbuseAutoBlock', () => {
  it('blocks the IPs the log query returns for the configured threshold and window', async () => {
    const { deps, block, getIPsWithHighAttempts } = setup();
    const result = await runOauthAbuseAutoBlock({ now: NOW, deps });

    expect(getIPsWithHighAttempts).toHaveBeenCalledWith(new Date(NOW.getTime() - 10 * MIN), 20);
    expect(result.evaluatedSince).toEqual(new Date(NOW.getTime() - 10 * MIN));
    expect(result.blocked.map(b => b.ip)).toEqual(['1.1.1.1', '2.2.2.2']);
    expect(block).toHaveBeenCalledWith('1.1.1.1', expect.stringContaining('25'), {
      durationMs: 10 * MIN,
      source: 'auto',
      escalationLevel: 0,
    });
  });

  it('writes nothing when disabled', async () => {
    const { deps, block, getIPsWithHighAttempts } = setup({ enabled: false });
    const result = await runOauthAbuseAutoBlock({ now: NOW, deps });
    expect(result.blocked).toEqual([]);
    expect(getIPsWithHighAttempts).not.toHaveBeenCalled();
    expect(block).not.toHaveBeenCalled();
  });

  it('escalates 10m -> 1h -> 24h and clamps, counting priors inside the lookback', async () => {
    const { deps, block, countAutoBlocksEndingSince } = setup({}, { '1.1.1.1': 1, '2.2.2.2': 7 });
    const result = await runOauthAbuseAutoBlock({ now: NOW, deps });

    expect(countAutoBlocksEndingSince).toHaveBeenCalledWith('1.1.1.1', new Date(NOW.getTime() - 24 * 60 * MIN));
    expect(result.blocked.map(b => [b.durationMs, b.escalationLevel])).toEqual([
      [60 * MIN, 1],
      [1440 * MIN, 2],
    ]);
    expect(block).toHaveBeenLastCalledWith(
      '2.2.2.2',
      expect.any(String),
      expect.objectContaining({ escalationLevel: 2 })
    );
  });

  it('does not re-block an IP an admin unblocked, on rows from before the unblock', async () => {
    const unblocked = { active: false, expiresAt: ago(-5 * MIN), unblockedAt: ago(2 * MIN) };
    const { deps, block, countAttemptsSince } = setup({}, {}, { '1.1.1.1': unblocked, '2.2.2.2': unblocked }, 3);
    const result = await runOauthAbuseAutoBlock({ now: NOW, deps });
    expect(countAttemptsSince).toHaveBeenCalledWith('1.1.1.1', ago(2 * MIN));
    expect(result.blocked).toEqual([]);
    expect(block).not.toHaveBeenCalled();
  });

  it('blocks again when new failures after the unblock reach the threshold, without escalating the unblock', async () => {
    const unblocked = { active: false, expiresAt: ago(-5 * MIN), unblockedAt: ago(2 * MIN) };
    const { deps, block } = setup({}, {}, { '1.1.1.1': unblocked }, 20);
    const result = await runOauthAbuseAutoBlock({ now: NOW, deps });
    expect(result.blocked.map(b => [b.ip, b.attempts, b.escalationLevel])).toEqual([
      ['1.1.1.1', 20, 0],
      ['2.2.2.2', 20, 0],
    ]);
    expect(block).toHaveBeenCalledTimes(2);
  });

  it('does not re-block at expiry when the window is longer than the first step', async () => {
    const expired = { active: true, expiresAt: ago(MIN) };
    const { deps, block } = setup({ windowMs: 60 * MIN }, { '1.1.1.1': 1, '2.2.2.2': 1 }, {
      '1.1.1.1': expired,
      '2.2.2.2': expired,
    });
    const result = await runOauthAbuseAutoBlock({ now: NOW, deps });
    expect(result.blocked).toEqual([]);
    expect(block).not.toHaveBeenCalled();
  });

  it('skips an IP that is blocked right now', async () => {
    const active = { active: true, expiresAt: ago(-5 * MIN) };
    const { deps, block, countAutoBlocksEndingSince } = setup({}, {}, { '1.1.1.1': active });
    const result = await runOauthAbuseAutoBlock({ now: NOW, deps });
    expect(result.blocked.map(b => b.ip)).toEqual(['2.2.2.2']);
    expect(block).toHaveBeenCalledTimes(1);
    expect(countAutoBlocksEndingSince).not.toHaveBeenCalledWith('1.1.1.1', expect.anything());
  });

  it('keeps going when one IP fails to block', async () => {
    const { deps, block } = setup();
    block.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runOauthAbuseAutoBlock({ now: NOW, deps });
    expect(result.blocked.map(b => b.ip)).toEqual(['2.2.2.2']);
  });
});

describe('default deps and policy', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.getIPs.mockResolvedValue([{ ip: '9.9.9.9', attempts: 7 }]);
    h.findLatest.mockResolvedValue(null);
    h.countBlocks.mockResolvedValue(1);
    h.block.mockResolvedValue({});
  });

  it('maps the admin settings to window, threshold, lookback and block duration', async () => {
    h.getSettingsMap.mockResolvedValue({
      oauthAbuseAutoBlockEnabled: 'true',
      oauthAbuseAttemptThreshold: '7',
      oauthAbuseWindowMinutes: '15',
      oauthAbuseBlockEscalationMinutes: '5,30,120',
      oauthAbuseLookbackHours: '48',
    });
    const result = await runOauthAbuseAutoBlock({ now: NOW });

    expect(h.getSettingsMap).toHaveBeenCalledWith(
      { adminSettings: { tag: 'settings' } },
      { skipCache: true, names: expect.arrayContaining(['oauthAbuseLookbackHours', 'oauthAbuseWindowMinutes']) }
    );
    expect(h.getIPs).toHaveBeenCalledWith(ago(15 * MIN), 7, OAUTH_ABUSE_REASONS);
    expect(h.countBlocks).toHaveBeenCalledWith('9.9.9.9', ago(48 * 60 * MIN));
    expect(h.block).toHaveBeenCalledWith('9.9.9.9', expect.any(String), {
      durationMs: 30 * MIN,
      source: 'auto',
      escalationLevel: 1,
    });
    expect(result.blocked[0].durationMs).toBe(30 * MIN);
  });

  it('falls back to the documented defaults when no settings are stored', async () => {
    h.getSettingsMap.mockResolvedValue({});
    h.countBlocks.mockResolvedValue(0);
    await runOauthAbuseAutoBlock({ now: NOW });
    expect(h.getIPs).toHaveBeenCalledWith(ago(10 * MIN), 20, OAUTH_ABUSE_REASONS);
    expect(h.countBlocks).toHaveBeenCalledWith('9.9.9.9', ago(24 * 60 * MIN));
    expect(h.block).toHaveBeenCalledWith('9.9.9.9', expect.any(String), expect.objectContaining({ durationMs: 10 * MIN }));
  });

  it('does nothing when the kill switch is off', async () => {
    h.getSettingsMap.mockResolvedValue({ oauthAbuseAutoBlockEnabled: 'false' });
    await runOauthAbuseAutoBlock({ now: NOW });
    expect(h.getIPs).not.toHaveBeenCalled();
  });

  it('stays at 24h for the block after an expired 24h block with the default settings', async () => {
    h.getSettingsMap.mockResolvedValue({});
    // The earlier 24h block expired 1 minute ago, so it is still inside the 24h lookback.
    h.findLatest.mockResolvedValue({ active: true, expiresAt: ago(MIN) });
    h.countForIP.mockResolvedValue(25);
    h.countBlocks.mockImplementation(async (_ip: string, since: Date) => (ago(MIN) >= since ? 2 : 0));
    const result = await runOauthAbuseAutoBlock({ now: NOW });
    expect(result.blocked.map(b => b.durationMs)).toEqual([1440 * MIN]);
  });
});

describe('escalation helpers', () => {
  it('resolveBlockDurationMs clamps to the last step', () => {
    expect(resolveBlockDurationMs(0, [1, 2, 3])).toBe(1);
    expect(resolveBlockDurationMs(2, [1, 2, 3])).toBe(3);
    expect(resolveBlockDurationMs(99, [1, 2, 3])).toBe(3);
  });

  it.each(['', '   ', 'abc', '10,0', '10,,60', '-5', '1.5'])('falls back to the default schedule for %j', raw => {
    expect(parseEscalationMinutes(raw)).toEqual([10, 60, 1440]);
  });

  it('parses a valid schedule', () => {
    expect(parseEscalationMinutes('5, 30,120')).toEqual([5, 30, 120]);
  });
});
